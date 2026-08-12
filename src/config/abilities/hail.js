/* ================================================================== */
/* HAILWRATH — frost, far cast                                         */
/* ================================================================== */
/**
 * A column of freezing air over the circle, and then it comes down.
 *
 * There is no travelling front here. The front is **vertical**: every stone
 * leaves one vanishing point high above and behind the caster and arrives on
 * its own timer, and that timer is a hash of *where it lands* rather than of
 * its index in an array — so the circle fills in patches that spread inward
 * from the boundary and no two seeds fill it in the same order.
 *
 * Two things in this block are worth understanding before you drag anything.
 *
 * **The envelope.** `stormRamp` / `stormPeak` / `stormTail` / `stormFloor`
 * shape how the arrival *rate* runs over the storm: up, over the top, and away.
 * They are not a schedule the ability walks — they are the four coefficients of
 * a curve whose integral is inverted into a clock, so moving any of them
 * re-times every stone that is still in the sky, including with the game
 * paused. `HailAbility`'s doc comment explains the mechanism and what it costs.
 *
 * **The pocks are unitless.** A stone that lands posts a *fraction of the
 * radius* into the ground field's event list, never a metre. That is what lets
 * `zoneRadius` re-scale a floor that is already cratered: drag it while paused
 * and the whole pattern of holes grows with the circle rather than sitting
 * inside a bigger one.
 *
 * Everything else obeys the usual rule — every dimension below is resolved
 * against this block inside the update loop, on a zero-length frame included.
 */
export const hail = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 120.0, // how fast the chill runs out to the circle, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.0, // the footprint the indicator draws, metres

  /* --- the storm clock --- */
  // `stormLead` + `stormTime` + `fallTime` is the IMPACT phase; `holdTime` is
  // the fade, during which the pocks rime over and the field thaws back.
  stormLead: 0.14, // seconds before the first stone leaves the cloud
  stormTime: 1.45, // seconds the launches are spread over
  fallTime: 0.45, // seconds one stone spends in the air, at the storm's peak rate
  holdTime: 2.8, // seconds the cratered floor stands after the last stone

  /* --- the arrival envelope --- */
  // The rate profile, integrated into a clock. See `HailAbility#_stormClock`.
  stormRamp: 1.4, // exponent on the rise; >1 starts slow and gathers
  stormPeak: 0.45, // where the peak sits, 0..1 of the storm
  stormTail: 2.0, // exponent on the fall; >1 tails off rather than stopping
  stormFloor: 0.35, // 0..1 rate floor — how much hail falls away from the peak

  /* --- how the circle fills --- */
  stones: 30, // stones in one cast (the pock list holds 32; see the class)
  fillBias: -1.0, // +1 fills outward from the middle, −1 inward from the rim
  fillScatter: 0.62, // 0 = a clean radial order, 1 = the spatial hash alone
  hashCell: 1.35, // the hash lattice, metres — about one stone's spacing
  rimCrowd: 0.62, // <0.5 crowds the boundary, >0.5 crowds the middle
  speedJitter: 0.22, // ±fraction on one stone's fall time

  /* --- one stone --- */
  stoneRadius: 0.17, // metres
  stoneJitter: 0.45, // ±fraction of that radius
  stoneStretch: 2.2, // scale along the velocity — a falling stone is a streak
  stoneAlign: 0.94, // 0 tumbles freely, 1 lays the long axis on the heading
  stoneSpin: 5.0, // residual tumble, radians/second
  stoneFlash: 0.1, // seconds the birth pop on a stone decays over
  skyHeight: 22.0, // metres above the floor the cloud sits at
  skyBack: 3.5, // metres behind the caster
  skySpread: 1.2, // ±metres of scatter around that one point
  fallCurve: 1.35, // easing on launch → land; >1 accelerates downward
  driftSide: 0.55, // metres of lateral drift on the way down
  driftTurns: 0.6, // cycles of that drift over the fall
  driftDecay: 1.8, // >0 pulls the drift to exactly zero at the floor

  /* --- the stone's silhouette (moving these rebuilds the geometry) --- */
  stoneFacets: 1, // icosphere subdivisions, 0–2. 1 is 80 triangles
  stoneLumps: 0.34, // low-frequency deformation, × the radius
  stoneLumpScale: 1.7, // lumps per unit radius
  stoneChip: 0.24, // high-frequency chipping
  stoneCuts: 6, // planar fracture faces sliced off it
  stoneCutDepth: 0.26, // how far those planes bite, × the radius

  /* --- the stone's shading --- */
  iceRoughness: 0.42, // surface roughness of the standard material
  iceMilk: 0.72, // how much cloudy core shows through the clear ice
  iceMilkScale: 3.1, // milk features per unit radius, sampled in LOCAL space
  iceFacetTint: 0.3, // per-facet value break-up
  iceRim: 1.3, // fresnel edge light
  iceRimPower: 2.4, // how tight that edge is
  iceGlint: 1.0, // the hard specks that catch the sun
  iceGlintScale: 7.5, // specks per unit radius
  iceLead: 0.75, // heat, or rather cold, on the leading facets
  iceLeadSharp: 2.6, // how tightly that hugs the heading
  iceGlow: 1.15, // emissive gain
  colorIce: '#f2fbff', // clear ice
  colorMilk: '#9fd8ee', // the cloudy core
  colorRim: '#dff4ff', // the fresnel edge
  colorGlint: '#ffffff', // the specks and the leading face

  /* --- the fall streak (one instanced strip, all thirty of them) --- */
  trailSpan: 0.16, // seconds of flight the streak reaches back over
  trailBurn: 0.1, // seconds the tail takes to catch the head after landing
  trailWidth: 0.055, // metres at the head
  trailTaper: 1.7, // >1 sharpens the tail to a point
  trailLift: 0.0, // metres the tail floats off the flown path
  trailOpacity: 0.85,
  trailGlow: 1.1,
  trailCore: 2.6, // how tightly light crowds the centre line
  trailHeadBias: 0.6, // >0 keeps the brightness near the stone
  trailNoise: 0.35,
  trailNoiseScale: 2.2, // features per metre
  trailNoiseSpeed: 1.1,
  trailSoftFade: 0.3, // metres of depth feather against solid geometry
  colorTrailA: '#ffffff',
  colorTrailB: '#dff4ff',
  colorTrailC: '#9fd8ee',
  colorTrailD: '#2a5d75',

  /* --- the pocked floor --- */
  // A GroundField in POCK mode. `pockRadius` is the size of one full-strength
  // crater in metres; everything the stones themselves post is a fraction.
  pockHeight: 0.02, // metres the quad floats above the floor
  pockRadius: 0.52, // metres, a full-strength crater
  pockDepth: 0.18, // metres it digs
  pockRim: 0.05, // metres of piled lip around it
  pockLift: 0.06, // metres that lip stands proud
  pockGrain: 0.4, // frost grain over the whole field, 0..1
  pockDig: 11.0, // how fast a crater digs itself in, events/second
  pockLife: 9.0, // seconds a crater weathers away over
  pockEdge: 0.55, // metres of feather on the field's own boundary
  pockRagged: 0.22, // how far that boundary wanders, × the radius
  pockRaggedScale: 0.55, // lobes per metre
  pockWarp: 0.6, // metres of domain warp on those lobes
  pockRelief: 0.85, // how hard the height field tilts the fake normal
  pockNormalStep: 0.05, // metres between the height taps
  pockAmbient: 0.36, // floor on the diffuse term
  pockWrap: 0.5, // 0..1 wraps the terminator round the back
  pockSpecular: 0.5,
  pockGloss: 30.0, // Blinn exponent
  pockParallax: 0.2, // metres of view-driven offset on the interior
  pockOpacity: 0.95,
  pockEmissive: 0.75, // multiplier on the cold glow in a fresh crater
  pockDepthFade: 0.4, // metres of soft fade against standing geometry
  colorPock: '#2a5d75', // the bruised stone the crater is cut into
  colorPockDeep: '#0d2530', // the bottom of the hole
  colorPockRim: '#f2fbff', // the white lip — the mark the ability is named for
  colorPockGlow: '#9fd8ee', // the cold that comes off a fresh one

  /* --- the rime-over --- */
  // Frost does not repaint the craters, it *spreads their lips*: `rimeRim` is
  // the same `thickness` the pocks already use, walked up over the hold, which
  // widens the white band until it closes over the bowl. Trying to do it by
  // crossfading the base colour looked like the floor was being tinted.
  rimeShare: 0.55, // 0..1 of the hold the frost takes to close over
  rimeRim: 0.17, // metres the lip has spread to at full rime
  rimeGrain: 0.95, // grain at full rime
  rimeSpecular: 1.35, // frost is glossier than wet stone
  rimeGloss: 70.0,
  rimeLift: 0.11, // metres the rimed lip stands proud
  thawStart: 0.62, // 0..1 of the hold before the field starts eating back

  /* --- the freezing column --- */
  mistRate: 60, // particles/second
  mistSize: 1.5,
  mistSpeed: 1.2, // metres/second
  mistLifetime: 2.4, // seconds
  mistRise: -0.5, // metres/second — this fog sinks
  mistOpacity: 0.1,
  mistTurbulence: 0.5,
  mistSpread: 0.85, // 0..1 of `zoneRadius` the column occupies
  mistHeight: 3.4, // metres of column above the floor
  colorMistA: '#dff4ff',
  colorMistB: '#9fd8ee',
  colorMistC: '#4d7f96',
  colorMistD: '#22404f',

  /* --- what one stone throws --- */
  chipCount: 9, // ice chips knocked off per stone
  chipSize: 0.06,
  chipSpeed: 5.5, // metres/second
  chipLifetime: 0.9, // seconds
  chipGravity: -19.0, // metres/second²
  chipSpread: 0.85, // 0..1 cone width
  chipSpin: 11.0, // radians/second
  colorChipA: '#ffffff',
  colorChipB: '#dff4ff',
  colorChipC: '#9fd8ee',
  colorChipD: '#3d6c82',
  sprayCount: 16, // the bright shatter spray
  spraySize: 0.1,
  spraySpeed: 8.5, // metres/second
  sprayLifetime: 0.35, // seconds
  sprayGravity: -13.0,
  sprayStretch: 0.22, // how far a streak smears along its velocity
  sprayRise: 0.55, // 0..1 how much of the spray goes up rather than out
  colorSprayA: '#ffffff',
  colorSprayB: '#ffffff',
  colorSprayC: '#9fd8ee',
  colorSprayD: '#2a5d75',

  /* --- the bounce --- */
  // One lit chip the size of the stone itself, thrown back up off the crater.
  // A second Projectile pass for one hop is two more draw calls and a whole
  // flight to keep in step with the first for something on screen for 200 ms.
  // It comes out of the chip system, so it falls under `chipGravity` — a
  // separate gravity slider here would be a control that does nothing, which is
  // worse than not having one.
  bounceSize: 0.13, // metres
  bounceSpeed: 4.2, // metres/second
  bounceLifetime: 0.45, // seconds
  bounceSpread: 0.35, // 0..1 how far off vertical it comes back
  bounceSpin: 7.0, // radians/second

  /* --- the glitter that lifts off the rime --- */
  glitterRate: 34, // particles/second, during the hold only
  glitterSize: 0.05,
  glitterSpeed: 0.7,
  glitterLifetime: 1.7,
  glitterRise: 0.8, // metres/second
  glitterTurbulence: 0.6,
  colorGlitterA: '#ffffff',
  colorGlitterB: '#dff4ff',
  colorGlitterC: '#9fd8ee',
  colorGlitterD: '#1d3f52',

  /* --- the shock of one stone landing --- */
  strikeShake: 0.1, // camera kick per stone
  strikeShakeDecay: 0.42, // seconds it decays over
  strikeLight: 1.4, // additive punch on the dynamic light per stone

  /* --- the cast itself --- */
  chillBurst: 2.6, // the shell of freezing vapour over the circle, metres
  chillIntensity: 1.1,
  chillFlash: 0.1, // screen flash when the column closes
  colorChillA: '#4d8fa8',
  colorChillB: '#9fd8ee',
  colorChillC: '#f2fbff',
  colorChillFlash: '#dff4ff',
  rumble: 0.035, // continuous shake while the storm falls

  /* --- dynamic light --- */
  lightIntensity: 9.0,
  lightRadius: 14.0,
  lightColor: '#9fd8ee'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Hailwrath.
 *
 * The four controls that carry the character of the slot are `stones`,
 * `stormTime`, `hashCell` and `fillScatter` — how much hail, over how long, in
 * how big a patch, and how strictly it works inward from the rim. After those,
 * "The arrival envelope" is where the drama lives: pull `stormFloor` to zero
 * and you can watch the mechanism, because the first stones stop falling.
 */
export const hailSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 20, 400, 1, 'chill speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['zoneRadius', 1, 14, 0.1, 'zone radius'],
    ['castAnim', 'cast animation']
  ],
  'The storm clock': [
    ['stormLead', 0, 2, 0.01, 'lead-in (s)'],
    ['stormTime', 0.2, 8, 0.01, 'storm length (s)'],
    ['fallTime', 0.1, 3, 0.01, 'fall time (s)'],
    ['holdTime', 0.3, 10, 0.05, 'hold (s)']
  ],
  'The arrival envelope': [
    ['stormRamp', 0.1, 6, 0.01, 'rise exponent'],
    ['stormPeak', 0.02, 0.98, 0.01, 'peak position'],
    ['stormTail', 0.1, 6, 0.01, 'fall exponent'],
    ['stormFloor', 0, 1, 0.01, 'rate floor']
  ],
  'How the circle fills': [
    ['stones', 1, 32, 1, 'stones'],
    ['fillBias', -1, 1, 0.01, 'radial order'],
    ['fillScatter', 0, 1, 0.01, 'hash vs radial'],
    ['hashCell', 0.05, 8, 0.05, 'hash cell (m)'],
    ['rimCrowd', 0.05, 3, 0.01, 'rim crowding'],
    ['speedJitter', 0, 1, 0.01, 'fall-time jitter']
  ],
  'One stone': [
    ['stoneRadius', 0.02, 1, 0.005, 'radius (m)'],
    ['stoneJitter', 0, 1, 0.01, 'size jitter'],
    ['stoneStretch', 0.2, 6, 0.01, 'stretch along velocity'],
    ['stoneAlign', 0, 1, 0.01, 'align to heading'],
    ['stoneSpin', 0, 30, 0.1, 'tumble (rad/s)'],
    ['stoneFlash', 0.01, 1, 0.01, 'birth pop (s)']
  ],
  'One stone/The fall': [
    ['skyHeight', 4, 60, 0.5, 'cloud height (m)'],
    ['skyBack', -10, 30, 0.1, 'cloud behind (m)'],
    ['skySpread', 0, 8, 0.05, 'cloud scatter (m)'],
    ['fallCurve', 0.3, 4, 0.01, 'fall easing'],
    ['driftSide', 0, 4, 0.01, 'lateral drift (m)'],
    ['driftTurns', 0, 4, 0.01, 'drift cycles'],
    ['driftDecay', 0, 5, 0.01, 'drift decay']
  ],
  'One stone/Silhouette': [
    ['stoneFacets', 0, 2, 1, 'subdivisions'],
    ['stoneLumps', 0, 1, 0.01, 'lumpiness'],
    ['stoneLumpScale', 0.2, 6, 0.05, 'lumps / radius'],
    ['stoneChip', 0, 0.6, 0.005, 'chipping'],
    ['stoneCuts', 0, 14, 1, 'cut faces'],
    ['stoneCutDepth', 0, 0.6, 0.005, 'cut depth']
  ],
  'One stone/Shading': [
    ['iceRoughness', 0.02, 1, 0.01, 'roughness'],
    ['iceMilk', 0, 1, 0.01, 'cloudy core'],
    ['iceMilkScale', 0.2, 12, 0.05, 'core scale'],
    ['iceFacetTint', 0, 1, 0.01, 'facet break-up'],
    ['iceRim', 0, 4, 0.01, 'fresnel edge'],
    ['iceRimPower', 0.2, 8, 0.05, 'edge tightness'],
    ['iceGlint', 0, 4, 0.01, 'glints'],
    ['iceGlintScale', 0.5, 24, 0.1, 'glints / radius'],
    ['iceLead', 0, 4, 0.01, 'leading face'],
    ['iceLeadSharp', 0.2, 8, 0.05, 'leading tightness'],
    ['iceGlow', 0, 4, 0.01, 'glow'],
    ['colorIce', 'clear ice'],
    ['colorMilk', 'cloudy core'],
    ['colorRim', 'fresnel edge'],
    ['colorGlint', 'glints']
  ],
  'The fall streak': [
    ['trailSpan', 0.01, 1.5, 0.005, 'streak length (s)'],
    ['trailBurn', 0.01, 1.5, 0.005, 'burn-off (s)'],
    ['trailWidth', 0.005, 0.5, 0.005, 'width (m)'],
    ['trailTaper', 0.2, 5, 0.01, 'taper'],
    ['trailLift', -0.5, 0.5, 0.005, 'lift (m)'],
    ['trailOpacity', 0, 2, 0.01, 'opacity'],
    ['trailGlow', 0, 5, 0.01, 'glow'],
    ['trailCore', 0.2, 8, 0.01, 'core tightness'],
    ['trailHeadBias', -1, 2, 0.01, 'head bias'],
    ['trailNoise', 0, 2, 0.01, 'noise'],
    ['trailNoiseScale', 0.1, 8, 0.05, 'noise scale'],
    ['trailNoiseSpeed', 0, 6, 0.05, 'noise speed'],
    ['trailSoftFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorTrail*', 'Streak colour']
  ],
  'The pocked floor': [
    ['pockHeight', 0, 0.3, 0.005, 'quad height (m)'],
    ['pockRadius', 0.05, 3, 0.01, 'crater radius (m)'],
    ['pockDepth', 0, 1.5, 0.005, 'crater depth (m)'],
    ['pockRim', 0.002, 0.5, 0.002, 'lip width (m)'],
    ['pockLift', 0, 0.5, 0.005, 'lip height (m)'],
    ['pockGrain', 0, 1, 0.01, 'grain'],
    ['pockDig', 0.5, 40, 0.5, 'dig rate'],
    ['pockLife', 0.5, 30, 0.1, 'crater lifetime (s)'],
    ['pockEdge', 0.02, 3, 0.01, 'field feather (m)'],
    ['pockRagged', 0, 1, 0.01, 'field raggedness'],
    ['pockRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['pockWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['pockOpacity', 0, 1, 0.01, 'opacity'],
    ['pockEmissive', 0, 3, 0.01, 'cold glow'],
    ['pockDepthFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorPock', 'bruised stone'],
    ['colorPockDeep', 'hole'],
    ['colorPockRim', 'white lip'],
    ['colorPockGlow', 'cold glow']
  ],
  'The pocked floor/Lighting': [
    ['pockRelief', 0, 3, 0.01, 'relief'],
    ['pockNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['pockAmbient', 0, 1, 0.01, 'ambient'],
    ['pockWrap', 0, 1, 0.01, 'terminator wrap'],
    ['pockSpecular', 0, 3, 0.01, 'specular'],
    ['pockGloss', 1, 160, 1, 'gloss'],
    ['pockParallax', 0, 1, 0.01, 'parallax (m)']
  ],
  'The rime-over': [
    ['rimeShare', 0.05, 1, 0.01, 'frost share of hold'],
    ['rimeRim', 0.002, 0.6, 0.002, 'rimed lip width (m)'],
    ['rimeGrain', 0, 1, 0.01, 'rimed grain'],
    ['rimeSpecular', 0, 3, 0.01, 'rimed specular'],
    ['rimeGloss', 1, 200, 1, 'rimed gloss'],
    ['rimeLift', 0, 0.6, 0.005, 'rimed lip height (m)'],
    ['thawStart', 0, 0.98, 0.01, 'thaw starts at']
  ],
  'The freezing column': [
    ['mistRate', 0, 400, 1, 'mist rate'],
    ['mistSize', 0.05, 6, 0.05, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.1, 8, 0.05, 'mist lifetime'],
    ['mistRise', -4, 4, 0.05, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistTurbulence', 0, 3, 0.01, 'mist turbulence'],
    ['mistSpread', 0, 1.5, 0.01, 'column width'],
    ['mistHeight', 0.2, 14, 0.1, 'column height (m)'],
    ['colorMist*', 'Mist colour']
  ],
  'What a stone throws': [
    ['chipCount', 0, 60, 1, 'chips / stone'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 25, 0.1, 'chip speed'],
    ['chipLifetime', 0.05, 4, 0.01, 'chip lifetime'],
    ['chipGravity', -60, 0, 0.5, 'chip gravity'],
    ['chipSpread', 0, 1, 0.01, 'chip cone'],
    ['chipSpin', 0, 30, 0.5, 'chip spin'],
    ['colorChip*', 'Chip colour'],
    ['sprayCount', 0, 80, 1, 'spray / stone'],
    ['spraySize', 0.005, 0.6, 0.005, 'spray size'],
    ['spraySpeed', 0, 30, 0.1, 'spray speed'],
    ['sprayLifetime', 0.05, 3, 0.01, 'spray lifetime'],
    ['sprayGravity', -60, 5, 0.5, 'spray gravity'],
    ['sprayStretch', 0, 2, 0.01, 'spray stretch'],
    ['sprayRise', 0, 1, 0.01, 'spray rise'],
    ['colorSpray*', 'Spray colour']
  ],
  'The bounce': [
    ['bounceSize', 0.01, 0.6, 0.005, 'bounce size (m)'],
    ['bounceSpeed', 0, 20, 0.1, 'bounce speed'],
    ['bounceLifetime', 0.05, 3, 0.01, 'bounce lifetime'],
    ['bounceSpread', 0, 1, 0.01, 'bounce cone'],
    ['bounceSpin', 0, 30, 0.5, 'bounce spin']
  ],
  'The glitter': [
    ['glitterRate', 0, 300, 1, 'glitter rate'],
    ['glitterSize', 0.005, 0.3, 0.005, 'glitter size'],
    ['glitterSpeed', 0, 8, 0.05, 'glitter speed'],
    ['glitterLifetime', 0.1, 6, 0.05, 'glitter lifetime'],
    ['glitterRise', -2, 6, 0.05, 'glitter rise'],
    ['glitterTurbulence', 0, 3, 0.01, 'glitter turbulence'],
    ['colorGlitter*', 'Glitter colour']
  ],
  'Impact & the cast': [
    ['strikeShake', 0, 1, 0.005, 'shake / stone'],
    ['strikeShakeDecay', 0.05, 2, 0.01, 'shake decay (s)'],
    ['strikeLight', 0, 10, 0.05, 'light punch / stone'],
    ['chillBurst', 0.1, 12, 0.05, 'chill shell (m)'],
    ['chillIntensity', 0, 5, 0.01, 'chill intensity'],
    ['chillFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'storm rumble'],
    ['colorChillA', 'chill shell'],
    ['colorChillB', 'chill body'],
    ['colorChillC', 'chill crest'],
    ['colorChillFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
