/* ================================================================== */
/* MAGMA — Magma Fount                                                 */
/* ================================================================== */
/**
 * A molten pool torn open in the floor, with a fount playing out of the middle
 * of it.
 *
 * **The pool is the ability.** It is a live heightfield — a real subdivided
 * plane with a displaced vertex shader — and everything interesting about it
 * falls out of one quantity the fragment shader computes honestly: the
 * **surface speed** in metres per second. Bulk drift, radial outflow from the
 * feed, eddies taken as the curl of a scalar field, and downhill gravity read
 * straight off the shading normal all add into it, and the black skin's
 * coverage is `1 − smoothstep(crustForm, crustBreak, speed)`.
 *
 * Nothing in the code says "crack when hit". A blob lands, its ripple steepens
 * the local slope, the slope feeds `flowGravity`, the flow carries the surface
 * past `crustBreak`, and the crust **tears open along the ripple front and
 * glows** — then heals behind it as the ripple decays. That coupling is the
 * whole reason the pool reads as molten rather than as an orange decal, and it
 * is why `flowGravity` is the single most important slider in this block.
 *
 * The cooling beat works the same way and for the same reason: the fade does
 * not paint the crust on, it takes the *flow* away (`flowRadial`, `flowEddy`
 * and `flowSpeed` all ramp to zero), and coverage goes to one on its own.
 *
 * The honest limitation, stated once so nobody looks for the bug: a fragment
 * cannot remember when it was last moving, so "the crust re-forms where the
 * surface is slow" is instantaneous in space and lagged in time only by
 * `crustFormTime`. Real skin has hysteresis. Buying it needs a ping-pong
 * buffer, which is a texture, which is **I2**.
 */
export const magma = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 46.0, // how fast the cast reaches the circle, metres/second
  zoneRadius: 4.6, // the footprint — drives the pool, the fount and the haze
  lifetime: 3.1, // seconds the fount runs at full tilt
  fadeTime: 2.8, // seconds it takes to cool
  cooldown: 2.4, // seconds before the slot re-arms
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats --- */
  preFill: 0.28, // 0..1 of the footprint the swelling reaches before it splits
  swellTime: 0.45, // seconds the pool takes to open out to full
  coolTime: 2.2, // seconds the flow takes to die once the fade starts
  fountRamp: 0.35, // seconds the fount takes to reach its full rate

  /* --- the sheet --- */
  round: 1.0, // 0 rectangular footprint, 1 elliptical
  edgeSoft: 0.11, // 0..1 of the field over which the waterline fades
  edgeNoise: 0.52, // 0..1 how ragged that line is
  edgeScale: 1.15, // cycles per metre of the raggedness
  poolOpacity: 1.0,
  contactFade: 0.3, // metres of soft fade against opaque geometry
  // Enough to clear the floor's own polygon without the waterline reading as a
  // lip standing off the ground.
  poolHeight: 0.06, // metres the mean plane sits above the floor

  /* --- the swell: four directional waves --- */
  // Long and slow, unlike water: lava is heavy and its swell is a heave rather
  // than a chop. Dropping waveLengthA below about two metres is the fastest way
  // to make the pool read as orange water.
  waveAmpA: 0.14, // metres
  waveAmpB: 0.08,
  waveAmpC: 0.045,
  waveAmpD: 0.022,
  waveLengthA: 6.4, // metres, crest to crest
  waveLengthB: 3.6,
  waveLengthC: 2.1,
  waveLengthD: 1.15,
  waveSpeedA: 0.6, // metres/second
  waveSpeedB: 0.45,
  waveSpeedC: 0.32,
  waveSpeedD: 0.24,
  waveAngleA: 0.35, // radians
  waveAngleB: 1.4,
  waveAngleC: 2.7,
  waveAngleD: 4.2,
  steepness: 0.5, // 0 sine, 1 Gerstner cusps; above ~1 the mesh self-folds

  /* --- chop --- */
  chop: 0.05, // metres
  chopScale: 1.3, // cycles per metre
  chopSpeed: 0.28, // metres/second the field drifts
  detail: 0.02, // metres — fragment-only, lives entirely in the normal
  detailScale: 6.2, // cycles per metre
  detailSpeed: 0.7, // metres/second

  /* --- ripples (what a landing blob punches in) --- */
  rippleAmp: 0.26, // metres at strength 1
  rippleSpeed: 3.6, // metres/second the front travels
  rippleLength: 1.15, // metres, crest to crest inside the packet
  rippleWidth: 0.85, // metres of the gaussian envelope
  rippleDecay: 1.5, // seconds to 1/e
  rippleSpread: 3.0, // metres over which it also thins with radius
  rippleStrength: 1.35, // dimensionless multiplier a landing blob arrives with

  /* --- the flow field (everything the crust does is a function of this) --- */
  // These five numbers decide how much of the pool is black at any moment, and
  // they were balanced by arithmetic before they were balanced by eye. At the
  // feed the radial term alone is nearly 2 m/s, which is over `crustBreak`, so
  // the middle stays bare melt; one 1/e length out it has fallen to a third of
  // that and the skin closes; at the rim the total sits at about 0.9 m/s, which
  // is coverage of roughly 0.7 — crusted, but with seams still open in it. Take
  // `flowRadialFall` up past about three metres and the whole pool goes bare,
  // which is the mistake the first tuning pass made and it looks like paint.
  flowAngle: 0.6, // radians, the bulk drift's bearing
  flowSpeed: 0.18, // metres/second of that drift
  flowRadial: 1.9, // metres/second outward at the feed
  flowRadialFall: 1.5, // metres to 1/e of that outflow
  flowEddy: 0.55, // metres/second of curl swirl
  flowEddyScale: 0.3, // cycles per metre of the eddies
  flowEddySpeed: 0.14, // Hz they churn at
  flowGravity: 2.6, // metres/second per unit of surface slope

  /* --- the crust --- */
  crust: 1.0, // 0..1 master; 0 skips the whole block
  crustForm: 0.55, // m/s below which the skin is unbroken
  crustBreak: 1.6, // m/s above which there is none
  crustFormTime: 0.85, // seconds for the first skin to chill
  crackScale: 1.05, // cycles per metre across the flow
  crackStretch: 5.2, // how many times longer features are along it
  crackWidth: 0.2, // 0..1 of the field — the seam's width
  crustAdvect: 1.0, // 0..1 how strongly the pattern is carried by the flow
  crustPeriod: 2.6, // seconds before the flow map resets
  crustBump: 0.5, // 0..1 how much the skin roughens the normal
  seamGlow: 3.2, // how hot the seams between plates run
  meltGlow: 1.5, // glow of the bare melt between the plates

  /* --- how the pool is shaded --- */
  poolDepth: 0.55, // metres of melt under the mean plane
  depthTint: 1.8, // Beer-Lambert density, per metre
  translucency: 0.9,
  ambient: 0.3,
  specular: 0.85,
  shininess: 42, // Blinn-Phong exponent
  fresnel: 1.0,
  envIntensity: 0.4,
  skyIntensity: 0.25,
  emissive: 1.15, // self-lit body — this is the one water must not have
  poolGlow: 1.4,
  normalEps: 0.05, // metres — the finite-difference step of the normal

  colorDeep: '#120806', // the melt at depth
  colorShallow: '#7a1a04', // the melt at the waterline
  colorCrust: '#0d0806', // the chilled skin
  colorSeam: '#ff5a12', // the crack between two plates of it
  colorHot: '#ffe08a', // the hottest the seams get
  colorSpec: '#ffb14a', // the specular highlight
  colorSky: '#2a1410', // what the surface reflects where it sees the sky

  /* --- the fount --- */
  blobs: 26, // blobs thrown over the whole hold (capped at 48)
  blobRadius: 0.28, // metres
  blobSizeJitter: 0.4, // ±fraction of that
  blobStretch: 1.25, // scale along the aligned axis
  blobAlign: 0.55, // 0 tumbles freely, 1 lays +Y along the heading
  blobSpin: 5.0, // tumble rate, radians/second
  blobFlash: 0.16, // seconds the birth flash takes to decay
  fountForward: 0.0, // metres downrange of the pool's centre
  fountSide: 0.0, // metres to the side of it
  fountHeight: 0.35, // metres above the floor the fount's mouth sits
  blobReach: 0.86, // fraction of `zoneRadius` a blob may land within
  blobBias: 0.62, // 0.5 uniform, <0.5 crowds the rim, >0.5 crowds the middle
  blobApex: 3.6, // ballistic loft, metres
  blobApexCurve: 0.9, // >1 flattens the top of the lob
  blobPathCurve: 1.0, // easing exponent on launch → land
  blobWeaveSide: 0.22, // lateral weave at launch, metres
  blobWeaveUp: 0.14, // vertical weave at launch, metres
  blobWeaveTurns: 1.1, // lateral cycles over the flight
  blobWeaveDecay: 1.5, // >0 pulls the weave to zero exactly at the landing
  blobFlight: 0.95, // seconds one blob is in the air
  blobSpeedJitter: 0.28, // ±fraction of flight time
  blobLead: 0.05, // seconds before the first blob leaves
  blobWindow: 3.0, // seconds the staggered launches are spread over
  blobFillBias: 0.3, // +1 fills outward from the centre, -1 inward from the rim
  blobFillScatter: 0.75, // 0 pure radial order, 1 pure spatial hash
  blobHashCell: 1.3, // hash lattice size, metres
  blobLinger: 0.5, // seconds a landed blob stays on the surface, sinking
  blobSink: 1.8, // body radii it sinks over that linger

  /* --- the blob's shape and skin --- */
  blobDetail: 1, // icosahedron subdivisions, 0..3
  blobLumpiness: 0.42, // how far the surface wanders off the sphere
  blobNoiseScale: 1.8, // features per unit radius
  blobRoughness: 0.14, // high-frequency grain on top
  blobCrust: 0.9, // 0..1 skin coverage by the time it lands
  blobCrustGrow: 1.5, // exponent on the flight — >1 chills late
  blobCrackScale: 2.8, // cycles per unit radius of the seams
  blobCrackWidth: 0.24, // 0..1 of the field — the seam's width
  blobSeamGlow: 1.4,
  blobRim: 0.9, // how hot the silhouette's edge runs
  blobRimPower: 2.1,
  blobShade: 0.6, // key-light term on the blob's crust
  blobAmbient: 0.24,
  blobFlashGain: 2.6, // extra heat on a blob that has just left the fount
  blobGlow: 1.7,
  blobOpacity: 1.0,
  blobSoftFade: 0.18, // metres of soft fade against solid geometry
  colorBlobHot: '#ffe08a',
  colorBlobMelt: '#ff5a12',
  colorBlobCrust: '#100807',
  colorBlobSeam: '#ff8a2a',

  /* --- the blob's trail --- */
  blobTrailSpan: 0.26, // seconds of flight the tail reaches back over
  blobTrailBurn: 0.2, // seconds the tail takes to catch up after landing
  blobTrailWidth: 0.19, // metres at the head
  blobTrailTaper: 1.5, // >1 sharpens the tail to a point
  blobTrailLift: 0.06, // metres the tail floats above the flown path
  blobTrailOpacity: 0.9,
  blobTrailGlow: 1.5,
  blobTrailCore: 2.0, // how tightly light crowds the centre line
  blobTrailHeadBias: 0.5, // >0 keeps the brightness near the blob
  blobTrailNoise: 0.55,
  blobTrailNoiseScale: 1.5, // features per metre
  blobTrailNoiseSpeed: 0.55,
  blobTrailSoftFade: 0.35, // metres of depth feather
  colorBlobTrailA: '#ffe6b0',
  colorBlobTrailB: '#ff9a3c',
  colorBlobTrailC: '#a82606',
  colorBlobTrailD: '#200603',

  /* --- the heat shimmer, which is the last thing left --- */
  /**
   * A `HEAT` emitter over the footprint. Its magnitudes are **screen
   * fractions**, not metres, and neither `post.distortion` nor
   * `global.distortion` belongs in `hazeStrength` — the pass applies both,
   * once, and multiplying them in here would square them.
   */
  hazeWidth: 1.9, // × zoneRadius — the column's width
  hazeHeight: 3.4, // metres the column stands
  hazeStrength: 0.42, // screen fractions at post.distortion = 1
  hazeOpacity: 1.0,
  hazeFrequency: 1.05, // cycles per metre
  hazeSpeed: 1.5, // metres/second the pattern rises
  hazeSourceBias: 1.6, // exponent pushing the wobble toward the floor
  hazeSpread: 0.85, // how much the column widens with height
  hazeVertical: 0.3, // how much of the offset is vertical
  hazeFlicker: 0.3,
  hazeDepthReject: 1.0, // 0..1 how hard it refuses to bend things in front
  hazeDepthFade: 0.4, // metres of depth feather on that
  hazePerspective: 0.35, // 0..1 how much the wobble shrinks with distance
  hazePerspectiveRef: 14.0, // metres at which it is drawn at full strength
  hazeHold: 1.4, // seconds into the cool before the haze starts to go
  hazeFade: 1.1, // seconds it then takes to go

  /* --- spatter, cinders and smoke --- */
  /**
   * Four-stop lifetime gradients as everywhere else, `A` at birth through `D`
   * as it dies. Spelled out rather than derived from the pool palette, so the
   * smoke can be made cold and grey while the melt stays gold.
   */
  spatterRate: 130, // droplets thrown off the fount, particles/second
  spatterSize: 0.12,
  spatterSpeed: 5.2,
  spatterLifetime: 1.1,
  spatterGravity: -14.0, // metres/second²
  spatterTurbulence: 0.5,
  spatterOnLanding: 16, // extra droplets thrown where a blob comes down
  colorSpatterA: '#fff0c8',
  colorSpatterB: '#ffb14a',
  colorSpatterC: '#ff5a12',
  colorSpatterD: '#5a1204',
  cinderRate: 34, // cooled chips flung out onto the floor, particles/second
  cinderSize: 0.07,
  cinderSpeed: 6.5,
  cinderLifetime: 1.6,
  cinderGravity: -17.0,
  colorCinderA: '#ff7a1f',
  colorCinderB: '#5a2410',
  colorCinderC: '#2a1a14',
  colorCinderD: '#1a120e',
  smokeRate: 55, // sulphurous haze off the surface, particles/second
  smokeSize: 1.3,
  smokeSpeed: 1.0,
  smokeLifetime: 3.2,
  smokeRise: 0.85,
  smokeOpacity: 0.1,
  colorSmokeA: '#4a3a30',
  colorSmokeB: '#3a2e26',
  colorSmokeC: '#2a221c',
  colorSmokeD: '#181310',

  /* --- what the floor around the pool gets --- */
  scorchRadius: 1.5, // char marks laid outside the waterline, metres
  scorchLife: 9.0, // seconds one lingers
  scorchIntensity: 0.6,
  scorchMarks: 9, // how many are laid when the floor splits
  colorScorch: '#100906', // the burn itself
  colorScorchEmber: '#ff6a1f', // the embers still cooling in it

  /* --- the split --- */
  burstSize: 3.4, // the shell thrown when the floor opens, metres
  burstIntensity: 1.6,
  burstSpatter: 190, // droplets thrown with it
  burstCinders: 70,
  shockRadius: 7.5, // ring snapped across the floor, metres
  colorShockA: '#ff8a2a', // body of that ring
  colorShockB: '#ffe08a', // its crest
  colorBurstA: '#7a1a04', // burst shell
  colorBurstB: '#ff5a12', // burst body
  colorBurstC: '#ffe08a', // the filaments racing over it
  colorFlash: '#ff8a2a', // the full-screen flash as it opens
  impactFlash: 0.2,
  impactShake: 0.95,
  shakeDuration: 0.8, // seconds that shake decays over
  rumble: 0.035, // continuous shake while the fount runs

  /* --- dynamic light --- */
  lightIntensity: 24, // the pool lights the stage from below
  lightRadius: 16,
  lightHeight: 0.6, // metres above the surface the light sits
  lightColor: '#ff6a1f',
  lightFlicker: 0.2, // depth of the gutter, 0 = steady
  lightFlickerSpeed: 8 // gutters/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Magma Fount.
 *
 * Reach for **The flow field** first. Every interesting thing the crust does is
 * a function of surface speed, and a pool with `flowSpeed`, `flowRadial` and
 * `flowEddy` all near zero has a speed of zero everywhere: uniform unbroken
 * skin, no seams, no heat, nothing to look at. `flowGravity` is the one that
 * couples a landing blob's ripple into the crust — take it to zero and the
 * blobs stop breaking the skin, which is the fastest way to see what that
 * coupling was buying.
 *
 * Then **The crust**: `crustForm` and `crustBreak` are the two speeds coverage
 * is interpolated between, so bringing them together hardens the boundary into
 * a shoreline and pushing them apart turns the whole pool into a gradient.
 *
 * `zoneRadius` deliberately drives four consumers at once — the sheet, the
 * blobs' landing disc, the heat column and the scorched ring — because a pool
 * whose fount lands outside it is not one thing.
 */
export const magmaSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'cast speed'],
    ['zoneRadius', 1, 14, 0.1, 'footprint radius'],
    ['lifetime', 0.2, 8, 0.05, 'fount duration'],
    ['fadeTime', 0.2, 8, 0.05, 'cool duration'],
    ['cooldown', 0, 10, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['preFill', 0, 1, 0.01, 'swell before the split'],
    ['swellTime', 0.05, 3, 0.01, 'time to open out'],
    ['coolTime', 0.1, 8, 0.05, 'time the flow takes to die'],
    ['fountRamp', 0.02, 2, 0.01, 'fount ramp-up']
  ],
  'The sheet': [
    ['round', 0, 1, 0.01, 'elliptical footprint'],
    ['edgeSoft', 0.01, 0.6, 0.005, 'waterline softness'],
    ['edgeNoise', 0, 1, 0.01, 'waterline raggedness'],
    ['edgeScale', 0.1, 4, 0.01, 'raggedness / metre'],
    ['poolOpacity', 0, 1, 0.01, 'pool opacity'],
    ['contactFade', 0.02, 2, 0.01, 'soft intersection'],
    ['poolHeight', 0, 1, 0.005, 'surface height']
  ],
  'The swell': [
    ['waveAmpA', 0, 1, 0.005, 'amp A'],
    ['waveAmpB', 0, 1, 0.005, 'amp B'],
    ['waveAmpC', 0, 1, 0.005, 'amp C'],
    ['waveAmpD', 0, 1, 0.005, 'amp D'],
    ['waveLengthA', 0.3, 20, 0.05, 'length A'],
    ['waveLengthB', 0.3, 20, 0.05, 'length B'],
    ['waveLengthC', 0.3, 20, 0.05, 'length C'],
    ['waveLengthD', 0.3, 20, 0.05, 'length D'],
    ['waveSpeedA', -4, 4, 0.01, 'speed A'],
    ['waveSpeedB', -4, 4, 0.01, 'speed B'],
    ['waveSpeedC', -4, 4, 0.01, 'speed C'],
    ['waveSpeedD', -4, 4, 0.01, 'speed D'],
    ['waveAngleA', 0, 6.29, 0.01, 'bearing A'],
    ['waveAngleB', 0, 6.29, 0.01, 'bearing B'],
    ['waveAngleC', 0, 6.29, 0.01, 'bearing C'],
    ['waveAngleD', 0, 6.29, 0.01, 'bearing D'],
    ['steepness', 0, 1.2, 0.01, 'gerstner steepness'],
    ['chop', 0, 0.5, 0.005, 'chop'],
    ['chopScale', 0.1, 6, 0.01, 'chop / metre'],
    ['chopSpeed', 0, 3, 0.01, 'chop drift'],
    ['detail', 0, 0.2, 0.001, 'normal detail'],
    ['detailScale', 0.5, 20, 0.1, 'detail / metre'],
    ['detailSpeed', 0, 4, 0.01, 'detail drift']
  ],
  'Ripples': [
    ['rippleAmp', 0, 1.5, 0.01, 'ripple height'],
    ['rippleSpeed', 0.2, 12, 0.05, 'front speed'],
    ['rippleLength', 0.1, 5, 0.01, 'wavelength'],
    ['rippleWidth', 0.05, 4, 0.01, 'packet width'],
    ['rippleDecay', 0.1, 6, 0.05, 'decay to 1/e'],
    ['rippleSpread', 0.2, 12, 0.05, 'radial thinning'],
    ['rippleStrength', 0, 4, 0.01, 'strength per blob']
  ],
  'The flow field': [
    ['flowAngle', 0, 6.29, 0.01, 'drift bearing'],
    ['flowSpeed', 0, 4, 0.01, 'drift speed'],
    ['flowRadial', 0, 6, 0.01, 'outflow at the feed'],
    ['flowRadialFall', 0.2, 12, 0.05, 'outflow falloff'],
    ['flowEddy', 0, 4, 0.01, 'eddy speed'],
    ['flowEddyScale', 0.02, 2, 0.01, 'eddies / metre'],
    ['flowEddySpeed', 0, 2, 0.01, 'eddy churn'],
    ['flowGravity', 0, 12, 0.05, 'downhill gain']
  ],
  'The crust': [
    ['crust', 0, 1, 0.01, 'crust master'],
    ['crustForm', 0, 4, 0.01, 'forms below (m/s)'],
    ['crustBreak', 0.05, 6, 0.01, 'breaks above (m/s)'],
    ['crustFormTime', 0.05, 5, 0.05, 'first skin time'],
    ['crackScale', 0.1, 5, 0.01, 'cracks / metre'],
    ['crackStretch', 1, 16, 0.1, 'stretch along the flow'],
    ['crackWidth', 0.01, 0.8, 0.005, 'seam width'],
    ['crustAdvect', 0, 1, 0.01, 'carried by the flow'],
    ['crustPeriod', 0.3, 8, 0.05, 'flow-map period'],
    ['crustBump', 0, 1, 0.01, 'skin roughness'],
    ['seamGlow', 0, 8, 0.05, 'seam glow'],
    ['meltGlow', 0, 6, 0.05, 'melt glow']
  ],
  'Pool shading': [
    ['poolDepth', 0.02, 3, 0.01, 'depth under the plane'],
    ['depthTint', 0, 6, 0.01, 'depth density'],
    ['translucency', 0, 3, 0.01, 'translucency'],
    ['ambient', 0, 2, 0.01, 'ambient'],
    ['specular', 0, 4, 0.01, 'specular'],
    ['shininess', 2, 200, 1, 'shininess'],
    ['fresnel', 0, 4, 0.01, 'fresnel'],
    ['envIntensity', 0, 3, 0.01, 'environment'],
    ['skyIntensity', 0, 3, 0.01, 'sky'],
    ['emissive', 0, 4, 0.01, 'self-lit'],
    ['poolGlow', 0, 6, 0.01, 'glow'],
    ['normalEps', 0.005, 0.3, 0.001, 'normal step'],
    ['colorDeep', 'melt at depth'],
    ['colorShallow', 'melt at the edge'],
    ['colorCrust', 'crust'],
    ['colorSeam', 'seam'],
    ['colorHot', 'hottest seam'],
    ['colorSpec', 'specular'],
    ['colorSky', 'sky reflection']
  ],
  'The fount': [
    ['blobs', 0, 48, 1, 'blobs'],
    ['blobRadius', 0.02, 1.5, 0.01, 'blob radius'],
    ['blobSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['blobStretch', 0.2, 4, 0.01, 'stretch'],
    ['blobAlign', 0, 1, 0.01, 'align to heading'],
    ['blobSpin', 0, 20, 0.1, 'tumble rate'],
    ['blobFlash', 0.01, 1, 0.01, 'birth flash'],
    ['fountForward', -6, 6, 0.05, 'fount forward'],
    ['fountSide', -6, 6, 0.05, 'fount lateral'],
    ['fountHeight', 0, 4, 0.01, 'fount height'],
    ['blobReach', 0.05, 1.5, 0.01, 'landing reach'],
    ['blobBias', 0.05, 3, 0.01, 'landing bias'],
    ['blobApex', 0, 14, 0.05, 'loft'],
    ['blobApexCurve', 0.1, 4, 0.01, 'loft curve'],
    ['blobPathCurve', 0.2, 4, 0.01, 'path easing'],
    ['blobWeaveSide', 0, 3, 0.01, 'lateral weave'],
    ['blobWeaveUp', 0, 3, 0.01, 'vertical weave'],
    ['blobWeaveTurns', 0, 6, 0.05, 'weave turns'],
    ['blobWeaveDecay', 0, 5, 0.01, 'weave decay'],
    ['blobFlight', 0.1, 4, 0.01, 'flight time'],
    ['blobSpeedJitter', 0, 1, 0.01, 'flight jitter'],
    ['blobLead', 0, 2, 0.01, 'first blob delay'],
    ['blobWindow', 0.1, 8, 0.05, 'launch window'],
    ['blobFillBias', -1, 1, 0.01, 'fill order'],
    ['blobFillScatter', 0, 1, 0.01, 'fill scatter'],
    ['blobHashCell', 0.1, 6, 0.05, 'hash cell'],
    ['blobLinger', 0, 2, 0.01, 'linger on landing'],
    ['blobSink', 0, 6, 0.05, 'sink depth (radii)']
  ],
  'The blob': [
    ['blobDetail', 0, 3, 1, 'subdivisions'],
    ['blobLumpiness', 0, 1, 0.01, 'lumpiness'],
    ['blobNoiseScale', 0.2, 6, 0.01, 'lump scale'],
    ['blobRoughness', 0, 0.6, 0.005, 'grain'],
    ['blobCrust', 0, 1, 0.01, 'crust coverage'],
    ['blobCrustGrow', 0.1, 5, 0.01, 'chill curve'],
    ['blobCrackScale', 0.2, 10, 0.05, 'cracks / radius'],
    ['blobCrackWidth', 0.01, 0.8, 0.005, 'seam width'],
    ['blobSeamGlow', 0, 5, 0.01, 'seam glow'],
    ['blobRim', 0, 4, 0.01, 'rim heat'],
    ['blobRimPower', 0.2, 6, 0.01, 'rim falloff'],
    ['blobShade', 0, 2, 0.01, 'key light'],
    ['blobAmbient', 0, 2, 0.01, 'ambient'],
    ['blobFlashGain', 0, 8, 0.05, 'birth heat'],
    ['blobGlow', 0, 6, 0.01, 'glow'],
    ['blobOpacity', 0, 1, 0.01, 'opacity'],
    ['blobSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorBlobHot', 'blob melt'],
    ['colorBlobMelt', 'blob rim'],
    ['colorBlobCrust', 'blob crust'],
    ['colorBlobSeam', 'blob seam']
  ],
  'The blob trail': [
    ['blobTrailSpan', 0.02, 2, 0.01, 'tail length (seconds)'],
    ['blobTrailBurn', 0.02, 2, 0.01, 'tail burn-back'],
    ['blobTrailWidth', 0.01, 1, 0.005, 'tail width'],
    ['blobTrailTaper', 0.1, 5, 0.01, 'tail taper'],
    ['blobTrailLift', -1, 2, 0.01, 'tail lift'],
    ['blobTrailOpacity', 0, 2, 0.01, 'opacity'],
    ['blobTrailGlow', 0, 6, 0.01, 'glow'],
    ['blobTrailCore', 0.1, 6, 0.01, 'core tightness'],
    ['blobTrailHeadBias', 0, 1, 0.01, 'head bias'],
    ['blobTrailNoise', 0, 3, 0.01, 'tail noise'],
    ['blobTrailNoiseScale', 0.1, 6, 0.01, 'noise / metre'],
    ['blobTrailNoiseSpeed', 0, 4, 0.01, 'noise speed'],
    ['blobTrailSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorBlobTrail*', 'Trail gradient']
  ],
  'Heat shimmer': [
    ['hazeWidth', 0.2, 5, 0.01, 'width (× radius)'],
    ['hazeHeight', 0.2, 14, 0.05, 'column height'],
    ['hazeStrength', 0, 2, 0.01, 'strength'],
    ['hazeOpacity', 0, 2, 0.01, 'opacity'],
    ['hazeFrequency', 0.05, 5, 0.01, 'cycles / metre'],
    ['hazeSpeed', 0, 8, 0.05, 'rise speed'],
    ['hazeSourceBias', 0.1, 6, 0.05, 'base bias'],
    ['hazeSpread', 0, 3, 0.01, 'widening'],
    ['hazeVertical', 0, 1, 0.01, 'vertical share'],
    ['hazeFlicker', 0, 2, 0.01, 'flicker'],
    ['hazeDepthReject', 0, 1, 0.01, 'depth reject'],
    ['hazeDepthFade', 0.02, 3, 0.01, 'depth feather'],
    ['hazePerspective', 0, 1, 0.01, 'distance falloff'],
    ['hazePerspectiveRef', 1, 40, 0.5, 'reference distance'],
    ['hazeHold', 0, 6, 0.05, 'holds for'],
    ['hazeFade', 0.05, 5, 0.05, 'then fades over']
  ],
  'Spatter & cinders': [
    ['spatterRate', 0, 600, 1, 'spatter rate'],
    ['spatterSize', 0.005, 0.6, 0.005, 'spatter size'],
    ['spatterSpeed', 0, 20, 0.1, 'spatter speed'],
    ['spatterLifetime', 0.05, 4, 0.01, 'spatter lifetime'],
    ['spatterGravity', -50, 5, 0.1, 'spatter gravity'],
    ['spatterTurbulence', 0, 3, 0.01, 'spatter turbulence'],
    ['spatterOnLanding', 0, 120, 1, 'spatter per landing'],
    ['cinderRate', 0, 300, 1, 'cinder rate'],
    ['cinderSize', 0.005, 0.4, 0.005, 'cinder size'],
    ['cinderSpeed', 0, 25, 0.1, 'cinder speed'],
    ['cinderLifetime', 0.1, 5, 0.05, 'cinder lifetime'],
    ['cinderGravity', -50, 0, 0.1, 'cinder gravity'],
    ['colorSpatter*', 'Spatter colour'],
    ['colorCinder*', 'Cinder colour']
  ],
  'Smoke & scorch': [
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 5, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 10, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['colorSmoke*', 'Smoke colour'],
    ['scorchRadius', 0.1, 8, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 30, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['scorchMarks', 0, 40, 1, 'scorch marks'],
    ['colorScorch', 'scorch'],
    ['colorScorchEmber', 'scorch embers']
  ],
  'The split': [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstSpatter', 0, 600, 1, 'burst spatter'],
    ['burstCinders', 0, 400, 1, 'burst cinders'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'sustain rumble'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorFlash', 'split flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 60, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
