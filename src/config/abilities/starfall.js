/* ================================================================== */
/* STARFALL — arcane, far cast                                         */
/* ================================================================== */
/**
 * A rain of cold light called down onto a circle.
 *
 * The whole ability turns on one number that is *not* a dimension of anything
 * you can see on the floor: the **vanishing point**. Every star in the call
 * leaves the same place — `skyBack` metres behind the caster and `skyHeight`
 * metres up — and lands somewhere else on the disc, so the trails all point
 * back at one spot in the sky and fan apart as they come down. That divergence
 * is the entire read. Drag `skyHeight` up and the fall steepens and the trails
 * crowd together; drag `skyBack` out and the whole rain leans over the caster's
 * shoulder. Two sliders and the sky moves.
 *
 * The first version gave every star its own launch point on a ring overhead,
 * on the theory that a shared origin would look like a fountain run backwards.
 * It looked like *rain*: twenty parallel streaks with no perspective in them at
 * all, because parallel lines with no common point have nothing for the eye to
 * converge on. `skyScatter` is what is left of that experiment — a few tens of
 * centimetres of slop around the vanishing point so the sky end is a small
 * bright knot rather than a mathematical singularity. Past about a metre the
 * read starts to go, which is why the slider tops out where it does.
 *
 * ### The arrival envelope
 *
 * The stars are not spread evenly through the window. `Projectile` turns a
 * body's landing point into a launch delay two ways at once — a radial ordering
 * of the disc, and a spatial hash of the floor — and `fillScatter` mixes them.
 * At 0 the circle fills in clean rings; at 1 it is confetti. In between, the
 * *sum of two differently shaped random variables* is a hump: few stars early,
 * a crowd through the middle of the window, a thinning tail. That is the ramp
 * and the tail, and it costs nothing because it falls out of the mixture rather
 * than being scheduled. `fillScatter` is therefore the envelope control as much
 * as it is the fill-order control, and it is worth dragging slowly.
 *
 * ### Cold, not warm
 *
 * Cinder Fall already owns "things come out of the sky and hit the floor". The
 * separation is entirely in the palette and the impact: no ember gradient
 * anywhere, no smoke that lingers, a *ring* on the floor rather than a crater,
 * and a thin white shell instead of a fireball. Every colour below is a picker
 * and none of them is derived from another, so it can be taken somewhere warm
 * on purpose — but the shipped defaults are white through pale blue into a deep
 * cobalt, and the dust is pale grey rather than soot.
 */
export const starfall = {
  /* --- the cast --- */
  range: 22.0, // maximum distance to the circle's centre, metres
  minRange: 3.0, // closer than this and the cast is refused, metres
  zoneRadius: 5.0, // radius of the circle the stars fall into, metres
  // Slow for a far cast, deliberately. The call has to still be running when
  // the first stars appear overhead or the sky opens onto an empty circle —
  // at 100 m/s the sweep was over before there was anything to look at.
  speed: 34.0, // how fast the call sweeps out to the circle, metres/second
  lifetime: 1.8, // seconds the rain holds after the call lands
  fadeTime: 1.2, // seconds the last light bleeds off
  cooldown: 1.4, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the vanishing point --- */
  // The three numbers that place the point every star falls from. Measured in
  // the cast's own frame, so the rain leans with the aim.
  skyHeight: 34.0, // metres above the floor
  skyBack: 13.0, // metres behind the caster
  skyScatter: 0.35, // metres of slop around it; 0 is a perfect convergence

  /* --- the fall: how many, when, and where they land --- */
  stars: 22, // stars in one call (capped at 40)
  starLead: 0.02, // seconds before the first star leaves the point
  starWindow: 1.4, // seconds the launches are spread over
  fallTime: 0.75, // seconds one star is in the air
  fallJitter: 0.14, // ± fraction of that flight time, per star
  fallCurve: 1.45, // >1 accelerates the star downward over its flight
  fillBias: -1.0, // +1 fills outward from the centre, -1 inward from the rim
  fillScatter: 0.65, // 0 pure radial order, 1 pure spatial hash — see the header
  hashCell: 1.4, // metres — the lattice the fill order clumps on
  zoneBias: 0.5, // 0.5 spreads evenly by area, <0.5 crowds the rim
  spreadHeight: 0.0, // metres above the floor a star is considered landed

  /* --- the star itself --- */
  starSize: 0.13, // body radius, metres
  starSizeJitter: 0.3, // ± fraction of that radius
  starStretch: 3.4, // how far the body is drawn out along its own heading
  starSpin: 2.0, // tumble, radians/second (mostly hidden once aligned)
  starAlign: 0.92, // 0 tumbles freely, 1 lays the long axis along the fall
  starFlash: 0.1, // seconds of birth flash as a star appears
  starGlow: 2.6, // emissive gain on the body
  starOpacity: 1.0,
  starRim: 2.2, // fresnel exponent on the body's edge
  starHeat: 1.6, // extra brightness as the star nears the floor
  starFacet: 0.55, // how hard the facets shimmer
  starFacets: 9.0, // facet features across the body (unitless — see the class)
  colorStarCore: '#ffffff', // the hot centre of the body
  colorStarEdge: '#c0d8ff', // its lit facets
  colorStarDeep: '#3a5fd0', // the side turned away from you

  /* --- the trail --- */
  /**
   * One instanced strip draws every trail, and it is not a recording: the
   * vertex shader re-flies the same parametric path backwards in each star's
   * own clock. That is why `trailSpan` re-lengthens a trail that is already in
   * the sky, with the clock stopped.
   */
  trailSpan: 0.34, // seconds of flight the tail reaches back over
  trailBurn: 0.3, // seconds the tail takes to catch the head after landing
  trailWidth: 0.11, // metres at the head
  trailTaper: 1.9, // >1 sharpens the tail to a point
  trailLift: 0.0, // metres the tail floats above the flown path
  trailOpacity: 0.95,
  trailGlow: 1.9,
  trailCore: 2.6, // how tightly light crowds the centre line
  trailHeadBias: 0.6, // >0 keeps the brightness near the body
  trailNoise: 0.35, // break-up along the ribbon
  trailNoiseScale: 1.1, // features per metre
  trailNoiseSpeed: 0.5,
  trailSoftFade: 0.45, // metres of depth feather against solid geometry
  colorTrailA: '#ffffff', // at the head
  colorTrailB: '#dbe9ff',
  colorTrailC: '#7aa0f0',
  colorTrailD: '#12224a', // at the tail

  /* --- the floor --- */
  /**
   * One `GroundField(POCK)` carries every impact, so the whole floor is a
   * single draw call however many stars land. A mark is a *unitless* hit —
   * fraction of the radius across, fraction downrange, and the timestamp it
   * fired at — which is why dragging `ringRadius` re-scales rings that are
   * already lying on the stone.
   *
   * POCK digs its crater in over `ringDig`, and the rim is a ridge at the
   * crater's edge. Run the dig slow and the rim *is* an expanding ring: it
   * travels outward as the mark grows and dies as it weathers. That is the
   * whole ring effect, and it is one uniform.
   */
  ringRadius: 0.85, // metres — the radius one impact ring reaches
  ringDig: 3.4, // how fast it expands to that radius, 1/second
  ringLife: 2.6, // seconds a ring takes to weather away
  ringRim: 0.12, // metres the rim stands proud — the ring's brightness
  ringDepth: 0.05, // metres the bowl sinks; small, these are not craters
  ringThickness: 0.07, // metres — how wide the rim ridge is
  ringDetail: 0.35, // grain over the floor mark
  fieldEdge: 0.45, // metres of feather on the circle's boundary
  fieldRagged: 0.16, // how far that boundary wanders, fraction of the radius
  fieldRaggedScale: 0.8, // lobes per metre
  fieldWarp: 0.4, // metres of domain warp on those lobes
  fieldRelief: 0.55, // how hard the height field tilts the fake normal
  fieldSpecular: 0.7,
  fieldGloss: 40, // Blinn exponent — tight and cold
  fieldEmissive: 1.5, // multiplier on the glowing terms
  fieldOpacity: 0.9,
  fieldHeight: 0.022, // metres the quad floats above the floor
  colorFieldBase: '#6f86b4', // the frosted stone inside the circle
  colorFieldEdge: '#eaf2ff', // rims and lips
  colorFieldGlow: '#9fc4ff', // the heat left in a fresh ring
  colorFieldDeep: '#101a34', // the inside of a bowl

  /* --- sparks, motes and dust --- */
  /**
   * Three shared systems, each with its own four-stop lifetime gradient (A at
   * birth through D as it dies) so the sparks can be made to cool while the
   * dust stays neutral. Nothing here is derived from the star palette.
   */
  sparkBurst: 16, // sparks thrown by one impact
  sparkSize: 0.13,
  sparkSpeed: 7.0, // metres/second
  sparkLifetime: 0.42, // seconds
  sparkGravity: -14.0, // metres/second²
  sparkStretch: 0.22, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#e8f2ff',
  colorSparkC: '#8fb8ff',
  colorSparkD: '#1b3470',
  moteBurst: 9, // slow motes released by one impact
  moteSize: 0.07,
  moteSpeed: 1.3, // metres/second
  moteLifetime: 1.5, // seconds
  moteRise: 1.1, // upward drift, metres/second
  moteTurbulence: 0.65,
  sparkleRate: 5.0, // motes shed per second *per star still in the air*
  colorMoteA: '#ffffff',
  colorMoteB: '#cfe2ff',
  colorMoteC: '#6f9aef',
  colorMoteD: '#0b1738',
  dustBurst: 5, // pale floor dust kicked up by one impact
  dustSize: 0.55,
  dustSpeed: 1.4, // metres/second
  dustLifetime: 1.6, // seconds
  dustRise: 0.5, // metres/second
  dustOpacity: 0.11,
  colorDustA: '#9fa8b8',
  colorDustB: '#8a94a6',
  colorDustC: '#6e7789',
  colorDustD: '#3b414c',

  /* --- the call, and what an impact does --- */
  callSize: 0.6, // the shell at the caster's hand on release, metres
  callIntensity: 1.6,
  callHeight: 1.32, // metres above the floor the call leaves from
  callForward: 0.5, // metres in front of the caster
  castFlash: 0.1, // screen flash on release
  colorCallA: '#3a5fd0',
  colorCallB: '#c0d8ff',
  colorCallC: '#ffffff',
  colorCastFlash: '#c0d8ff',
  shellSize: 1.15, // the shell one star opens where it lands, metres
  shellIntensity: 1.5,
  shellLife: 0.34, // seconds — short, or twenty of them stack into a fog
  colorShellA: '#3a5fd0',
  colorShellB: '#c0d8ff',
  colorShellC: '#ffffff',
  impactFlash: 0.16, // screen flash, fired by the *first* star only
  colorFlash: '#dfeaff',
  impactShake: 0.16, // per-star kick
  shakeDuration: 0.3, // seconds it decays over
  rumble: 0.02, // continuous shake while the rain is falling

  /* --- dynamic light --- */
  lightIntensity: 12, // the standing glow over the circle
  lightRadius: 16, // metres
  lightColor: '#9fc4ff',
  lightTwinkle: 0.22, // depth of the cold twinkle, 0 = steady
  lightTwinkleSpeed: 7.0, // twinkles/second
  lightPunch: 9.0 // added to the light by each star that lands
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Starfall.
 *
 * Reach for **The vanishing point** first — it is the ability. `skyHeight` and
 * `skyBack` between them decide whether this reads as a meteor shower seen from
 * underneath or as light dropped straight down a lift shaft, and both extremes
 * are worth seeing once. After that, `fillScatter` (which is the arrival
 * envelope), `stars` and `starWindow` set the weather, and `ringDig` decides
 * whether the floor marks snap or spread.
 */
export const starfallSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 16, 0.1, 'circle radius'],
    ['speed', 5, 300, 1, 'call speed'],
    ['lifetime', 0.2, 8, 0.05, 'rain duration'],
    ['fadeTime', 0.1, 5, 0.05, 'fade time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The vanishing point': [
    ['skyHeight', 6, 90, 0.5, 'height above floor'],
    ['skyBack', -20, 50, 0.5, 'distance behind caster'],
    ['skyScatter', 0, 4, 0.01, 'convergence slop']
  ],
  'The fall': [
    ['stars', 1, 40, 1, 'stars'],
    ['starLead', 0, 2, 0.01, 'lead-in'],
    ['starWindow', 0.05, 6, 0.01, 'arrival window'],
    ['fallTime', 0.1, 3, 0.01, 'time in the air'],
    ['fallJitter', 0, 1, 0.01, 'flight-time jitter'],
    ['fallCurve', 0.4, 3.5, 0.01, 'fall acceleration'],
    ['fillBias', -1, 1, 0.01, 'fill order (rim ↔ centre)'],
    ['fillScatter', 0, 1, 0.01, 'arrival envelope'],
    ['hashCell', 0.1, 8, 0.05, 'clump size'],
    ['zoneBias', 0.1, 2, 0.01, 'rim ↔ middle crowding'],
    ['spreadHeight', 0, 2, 0.01, 'landing height']
  ],
  'The star': [
    ['starSize', 0.02, 0.8, 0.005, 'body radius'],
    ['starSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['starStretch', 0.5, 12, 0.05, 'stretch along heading'],
    ['starSpin', 0, 20, 0.1, 'tumble rate'],
    ['starAlign', 0, 1, 0.01, 'align to heading'],
    ['starFlash', 0.01, 1, 0.01, 'birth flash'],
    ['starGlow', 0, 8, 0.01, 'glow'],
    ['starOpacity', 0, 2, 0.01, 'opacity'],
    ['starRim', 0.2, 8, 0.05, 'rim sharpness'],
    ['starHeat', 0, 5, 0.01, 'heat near the floor'],
    ['starFacet', 0, 2, 0.01, 'facet depth'],
    ['starFacets', 1, 30, 0.5, 'facets across body'],
    ['colorStarCore', 'star core'],
    ['colorStarEdge', 'star facets'],
    ['colorStarDeep', 'star shadow']
  ],
  'The trail': [
    ['trailSpan', 0.02, 2, 0.01, 'trail length (seconds)'],
    ['trailBurn', 0.02, 2, 0.01, 'tail catch-up'],
    ['trailWidth', 0.005, 1, 0.005, 'width at head'],
    ['trailTaper', 0.2, 6, 0.05, 'taper'],
    ['trailLift', -1, 1, 0.01, 'lift off the path'],
    ['trailOpacity', 0, 2, 0.01, 'opacity'],
    ['trailGlow', 0, 6, 0.01, 'glow'],
    ['trailCore', 0.2, 8, 0.05, 'core tightness'],
    ['trailHeadBias', -1, 2, 0.01, 'head bias'],
    ['trailNoise', 0, 2, 0.01, 'break-up'],
    ['trailNoiseScale', 0.1, 8, 0.05, 'break-up scale'],
    ['trailNoiseSpeed', 0, 4, 0.01, 'break-up speed'],
    ['trailSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorTrail*', 'Trail colour']
  ],
  'The floor': [
    ['ringRadius', 0.05, 4, 0.01, 'ring radius'],
    ['ringDig', 0.2, 20, 0.1, 'ring expansion rate'],
    ['ringLife', 0.2, 14, 0.1, 'ring lifetime'],
    ['ringRim', 0, 0.6, 0.005, 'rim height'],
    ['ringDepth', 0, 1, 0.005, 'bowl depth'],
    ['ringThickness', 0.005, 0.5, 0.005, 'rim width'],
    ['ringDetail', 0, 1, 0.01, 'floor grain'],
    ['fieldEdge', 0.02, 3, 0.01, 'boundary feather'],
    ['fieldRagged', 0, 1, 0.01, 'boundary wander'],
    ['fieldRaggedScale', 0.1, 4, 0.05, 'wander scale'],
    ['fieldWarp', 0, 3, 0.01, 'domain warp'],
    ['fieldRelief', 0, 2, 0.01, 'relief'],
    ['fieldSpecular', 0, 3, 0.01, 'specular'],
    ['fieldGloss', 1, 120, 1, 'gloss'],
    ['fieldEmissive', 0, 5, 0.01, 'emissive'],
    ['fieldOpacity', 0, 2, 0.01, 'opacity'],
    ['fieldHeight', 0.001, 0.2, 0.001, 'height above floor'],
    ['colorFieldBase', 'floor body'],
    ['colorFieldEdge', 'floor rims'],
    ['colorFieldGlow', 'ring heat'],
    ['colorFieldDeep', 'bowl interior']
  ],
  'Sparks & motes': [
    ['sparkBurst', 0, 120, 1, 'sparks / impact'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['moteBurst', 0, 80, 1, 'motes / impact'],
    ['moteSize', 0.005, 0.5, 0.005, 'mote size'],
    ['moteSpeed', 0, 10, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 6, 0.05, 'mote lifetime'],
    ['moteRise', -2, 6, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['sparkleRate', 0, 60, 0.5, 'sparkle / star / sec'],
    ['colorSpark*', 'Spark colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Floor dust': [
    ['dustBurst', 0, 60, 1, 'dust / impact'],
    ['dustSize', 0.05, 3, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 6, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['colorDust*', 'Dust colour']
  ],
  'The call & the impacts': [
    ['callSize', 0.05, 6, 0.05, 'call shell size'],
    ['callIntensity', 0, 5, 0.01, 'call intensity'],
    ['callHeight', 0, 3, 0.01, 'hand height'],
    ['callForward', -1, 3, 0.01, 'hand forward'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCallA', 'call shell'],
    ['colorCallB', 'call body'],
    ['colorCallC', 'call arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['shellSize', 0.05, 6, 0.05, 'impact shell size'],
    ['shellIntensity', 0, 5, 0.01, 'impact shell intensity'],
    ['shellLife', 0.05, 2, 0.01, 'impact shell life'],
    ['colorShellA', 'impact shell'],
    ['colorShellB', 'impact body'],
    ['colorShellC', 'impact rim'],
    ['impactFlash', 0, 2, 0.01, 'first-star screen flash'],
    ['colorFlash', 'screen flash colour'],
    ['impactShake', 0, 2, 0.01, 'per-star shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake decay'],
    ['rumble', 0, 0.4, 0.005, 'rain rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightTwinkle', 0, 1, 0.01, 'twinkle depth'],
    ['lightTwinkleSpeed', 0.5, 40, 0.5, 'twinkle rate'],
    ['lightPunch', 0, 60, 0.5, 'punch per star'],
    ['lightColor', 'light colour']
  ]
};
