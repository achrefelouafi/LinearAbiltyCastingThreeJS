/* ================================================================== */
/* TIDERUSH — tide · line                                              */
/* ================================================================== */
/**
 * A breaking wave runs down the aimed line and lights the floor through itself.
 *
 * The block is long for the same reason `crimsontide`'s is — a heightfield has
 * genuinely more dimensions than a bolt — but the group that matters here is
 * **the net**, and it is the only group in the file that is not about water at
 * all. It is about *light that has been through* water:
 *
 *  - `netDepth` / `netDepthCrest` — how many metres of water the light crosses.
 *    This is the single strongest control in the file. The refraction map is
 *    `A(xz) = xz − (1 − 1/ior)·D·∇h`, so `D` is the lever arm on the fold: at
 *    `netDepth` 0 there is no fold anywhere and the floor is empty, and past
 *    about a metre and a half the folds overlap into a wash. `netDepthCrest`
 *    adds metres in proportion to the crest's *current* height, so the net
 *    sharpens as the wave rises and slackens as it dumps — which is the whole
 *    reason you can read the wave's body off the ground.
 *  - `netAbsorb` — Beer extinction down the water column, per metre. This is
 *    the term that draws the wave's *thickness*: the column under the crest is
 *    a metre deeper than the column on its face, so the net goes dark under the
 *    body and flares in the thin water ahead of the lip. Set it to 0 and the
 *    cast still renders, and the trick is gone.
 *  - `netStep` — metres between the six Hessian taps. It is the net's finest
 *    detail and its aliasing limit in one number: below about 0.04 m the
 *    filaments are thinner than a floor pixel at a normal camera height and
 *    they crawl.
 *
 * **The swell is authored in mirror pairs, and that is not decoration.** A/B
 * and C/D carry equal amplitudes, lengths and speeds at opposite bearings
 * (`+0.36` / `−0.36`). The reason is in `TiderushAbility`'s header: the ground
 * quad the caustics are drawn on has a right-handed frame and `LiquidSurface`'s
 * does not, so the net is the water's mirror image across the lane. A wave set
 * that is symmetric about the lane is mapped onto *itself* by that mirror, so
 * the net and the water agree exactly. Break the pairing — give B a different
 * amplitude from A — and the grain of the light on the floor starts to lean the
 * other way from the grain on the water. It is a small effect and it is the
 * kind of small effect this whole ability is a demonstration of, so the pairs
 * are the default and the sliders are there to be broken deliberately.
 *
 * **No crust, no melt glow.** Water does not skin over, so `crust` is never
 * written and `LiquidSurface`'s crust block is skipped entirely. Its *melt*
 * glow is not gated by `crust`, though, and it defaults to 1.2 — the ability
 * pins it to zero by hand, because a warm emissive haze over cold water was the
 * first thing this cast did wrong.
 */
export const tiderush = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 12.0, // how fast the surge runs down the line, metres/second
  breakTime: 0.8, // seconds the crest spends pitching over and collapsing
  drainTime: 2.2, // seconds the sheet takes to run off the floor
  cooldown: 1.05,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the travelling window ----------------------------------------- */
  // The sheet is a fixed-length window of water that travels with the crest,
  // not a plane the length of the cast. Everything here is re-read every frame.
  sheetSpan: 13.0, // metres of water the window holds, tail to leading edge
  crestSeat: 0.62, // 0..1 where in that window the crest stands
  sheetTail: 1.8, // metres behind the caster the tail is pinned until it unpins
  sheetWidth: 7.4, // metres across the line the water spans
  sheetHeight: 0.05, // metres the mean plane floats above the floor
  sheetFill: 1.0, // 0..1 of the half-extent the water reaches; the drain rides this
  sheetRound: 0.28, // 0 rectangular footprint, 1 elliptical
  sheetEdge: 0.17, // 0..1 of the field over which the waterline fades out
  sheetRagged: 0.4, // 0..1 how ragged that waterline is
  sheetRaggedScale: 1.05, // cycles per metre of the raggedness
  sheetOpacity: 1.0,
  contactFade: 0.22, // metres of soft fade where the sheet meets standing geometry

  /* --- the swell: four directional waves, in mirror pairs -------------- */
  swellAmpA: 0.12, // metres
  swellAmpB: 0.12, //   pair of A
  swellAmpC: 0.05,
  swellAmpD: 0.05, //   pair of C
  swellLengthA: 5.6, // metres, crest to crest
  swellLengthB: 5.6,
  swellLengthC: 2.3,
  swellLengthD: 2.3,
  swellSpeedA: 2.3, // metres/second
  swellSpeedB: 2.3,
  swellSpeedC: 1.4,
  swellSpeedD: 1.4,
  swellAngleA: 0.36, // radians in the sheet's frame; 0 is downrange
  swellAngleB: -0.36, //  the mirror of A — see the header
  swellAngleC: 1.22,
  swellAngleD: -1.22, //  the mirror of C
  steepness: 0.52, // 0 sine, 1 Gerstner cusps

  /* --- chop and grain -------------------------------------------------- */
  chop: 0.045, // metres of high-frequency displacement
  chopScale: 1.75, // cycles per metre
  chopSpeed: 0.55, // metres/second the chop field drifts
  detail: 0.016, // metres — fragment-only; lives entirely in the normal
  detailScale: 8.2, // cycles per metre
  detailSpeed: 1.15,

  /* --- the crest ------------------------------------------------------- */
  // `crestBack / crestFace` is the silhouette: a symmetric bump is a swell, a
  // bump with a face a ninth as long as its back is a wave about to break.
  crestHeight: 1.15, // metres at full surge
  crestBack: 2.7, // metres — the long back slope's 1/e length
  crestFace: 0.3, // metres — the short front face's 1/e length
  crestCurl: 0.62, // metres of forward throw per metre of height
  crestWidth: 0.82, // 0..1 of the half-extent across the wave
  crestFeather: 0.26, // 0..1 of that, over which the ends die
  crestBreak: 0.3, // 0..1 how ragged the lip is
  crestBreakScale: 1.2, // cycles per metre along the lip
  crestRise: 0.3, // 0..1 of the run the crest takes to reach full height
  crestPeak: 1.45, // multiplier on the height at the moment it pitches
  crestCurlPeak: 2.1, // multiplier on the curl at the break
  crestBreakPeak: 2.3, // multiplier on the raggedness at the break
  crestOvershoot: 2.4, // metres the lip is thrown past the end of the line

  /* --- ripples (the lip smacking down rings the sheet) ----------------- */
  rippleAmp: 0.16, // metres at strength 1
  rippleSpeed: 3.4, // metres/second the ring travels
  rippleLength: 1.05, // metres, crest to crest inside the packet
  rippleWidth: 0.8, // metres of the gaussian envelope
  rippleDecay: 1.15, // seconds to 1/e
  rippleSpread: 3.2, // metres over which it also thins with radius
  rippleRate: 4.5, // packets per second posted under the lip
  rippleSpan: 0.25, // 0..1 lateral scatter of those packets — kept small on purpose

  /* --- the flow field (water has no crust; this only seeds foam) -------- */
  flowAngle: 0.0, // radians, the bulk drift's bearing in the sheet's frame
  flowSpeed: 1.5, // metres/second of bulk drift
  flowRadial: 0.45, // metres/second outward at the sheet's centre
  flowRadialFall: 4.5, // metres to 1/e
  flowEddy: 0.55, // metres/second of curl swirl
  flowEddyScale: 0.3, // cycles per metre
  flowEddySpeed: 0.18, // Hz the eddies churn
  flowGravity: 3.2, // metres/second per unit of surface slope

  /* --- foam ------------------------------------------------------------ */
  foam: 0.85, // 0..1 master
  foamScale: 5.2, // cycles per metre of the speckle
  foamSharp: 1.25,
  foamCrest: 1.25, // how much the breaking lip seeds it
  foamSpeed: 0.6, // how much surface speed seeds it
  // The two surface speeds the froth is gated between. They are `LiquidSurface`'s
  // `crustForm` / `crustBreak` — the same pair the skin would die between. Water
  // has no skin, so here they are only the foam's gate, and they are named for
  // what they do in this cast rather than for the box they land in.
  foamGateLow: 0.5, // m/s below which the surface is calm and bare
  foamGateHigh: 2.4, // m/s above which it is fully frothed

  /* --- shading --------------------------------------------------------- */
  poolDepth: 0.35, // metres of water under the mean plane
  depthTint: 1.35, // Beer-Lambert density in the body, per metre
  translucency: 1.7, // backlight through the folded lip
  ambient: 0.3,
  specular: 1.7,
  shininess: 90, // Blinn-Phong exponent
  fresnel: 1.2,
  envIntensity: 0.85,
  skyIntensity: 0.55,
  glow: 1.0,
  normalEps: 0.04, // metres — the finite-difference step of the shading normal
  colorDeep: '#06222e', // the body
  colorShallow: '#2ea3b4', // thin water and the backlit lip
  colorFoam: '#e8fbff', // froth
  colorSpec: '#ffffff', // highlight
  colorSky: '#39627a', // the sky fallback under the reflection

  /* --- the caustic net ------------------------------------------------- */
  // THE TRICK. Bound to the sheet's own uniform boxes, so every number below is
  // about the *light*, and every number about the *water* is upstairs.
  // The net's reach is a multiple of the sheet's own HALF-WIDTH, not a metre of
  // its own. The projector is a disc measured in the sheet's frame, the sheet
  // is a long rectangle, and a disc big enough to reach the far end of the lane
  // is a disc that throws filaments three metres out into dry floor either side
  // of it. Tying it to the water is the fix, and it is also correct: light on
  // the ground past the waterline is light that came through nothing.
  netReach: 1.05, // × the sheet's half-width

  netHeight: 0.014, // metres the quad floats above the floor
  netDepth: 0.5, // metres of water the light crosses at rest
  netDepthCrest: 0.55, // extra metres per metre of the crest's current height
  netIor: 1.335, // water. The shader is handed 1 − 1/ior
  netDispersion: 0.07, // 0..1 how far the red and blue folds sit either side of green
  netStep: 0.075, // metres between the six Hessian taps
  netAbsorb: 0.32, // 1/metres down the water column — the thickness read
  netFoldFloor: 0.2, // keeps 1/|det| finite; also the widest a filament gets
  netThreshold: 1.05, // compression below this is flat water, and black
  netGain: 0.62,
  netSharp: 1.4, // exponent on the surviving compression
  netRolloff: 0.2, // soft clip, so a fold does not detonate the bloom
  netPenumbra: 0.42, // 0..1 of the reach over which the pool of light dies
  netWash: 0.14, // the general lit-pool light between the filaments
  netFringeAt: 1.5, // where on the fold the colour hands over to the fringe
  netEmissive: 1.5,
  netOpacity: 1.0,
  netDepthFade: 0.4, // metres of soft fade against anything standing on the floor
  netBreakGain: 2.0, // multiplier on the gain through the break
  colorNet: '#a8f0ff', // the filaments
  colorFringe: '#ffffff', // the very top of a fold
  colorWash: '#1d5f78', // the general light in the pool

  /* --- droplets off the lip -------------------------------------------- */
  sprayRate: 210, // droplets/second
  spraySize: 0.07, // metres
  spraySpeed: 5.5, // metres/second
  sprayLifetime: 1.1, // seconds
  sprayGravity: -14.0, // metres/second²
  colorSprayA: '#dff8ff',
  colorSprayB: '#8fdcee',
  colorSprayC: '#3f93aa',
  colorSprayD: '#123444',

  /* --- the haze standing over the break -------------------------------- */
  mistRate: 46, // puffs/second
  mistSize: 0.85, // metres
  mistSpeed: 1.5, // metres/second
  mistLifetime: 2.2, // seconds
  mistRise: 0.5, // metres/second²
  mistOpacity: 0.5,
  mistTurbulence: 0.7,
  colorMistA: '#cfeef6',
  colorMistB: '#9cc6d4',
  colorMistC: '#5c8494',
  colorMistD: '#22343c',

  /* --- glints: airborne droplets catching the same refracted light ----- */
  glintRate: 70, // glints/second
  glintSize: 0.05, // metres
  glintSpeed: 3.2, // metres/second
  glintLifetime: 0.9, // seconds
  glintGravity: -9.0, // metres/second²
  glintGlow: 2.2,
  colorGlintA: '#ffffff',
  colorGlintB: '#b8f4ff',
  colorGlintC: '#4fc0dc',
  colorGlintD: '#0d3b4c',

  /* --- what the wave leaves on the floor -------------------------------- */
  wetRate: 1.2, // marks per METRE of front travel, not per second
  wetRadius: 2.4, // metres
  wetLife: 4.5, // seconds
  wetIntensity: 1.0,
  colorWetA: '#0d2a34', // soaked stone
  colorWetB: '#bfe8f2', // the drying tide line

  /* --- the break --------------------------------------------------------- */
  burstSize: 3.2, // metres
  burstIntensity: 1.5,
  burstSpray: 220, // droplets thrown out of the collapse
  burstGlints: 90,
  burstRipples: 4, // ripple packets posted into the sheet
  shockRadius: 5.5, // metres
  impactShake: 0.5,
  shakeDuration: 0.6, // seconds
  impactFlash: 0.1, // 0..1 screen flash
  rumble: 0.06, // per-second shake while the surge runs
  colorBurstA: '#eafcff',
  colorBurstB: '#63c8e0',
  colorBurstC: '#0f4256',
  colorShockA: '#d9f7ff',
  colorShockB: '#3aa8c4',
  colorFlash: '#9fe4f4',

  /* --- dynamic light ------------------------------------------------------ */
  lightIntensity: 14.0,
  lightRadius: 12.0,
  lightColor: '#7fe4ff'
};

/** Editor layout. Folder order is the order they are built in. */
export const tiderushSchema = {
  'The cast': ['range', 'minRange', 'speed', ['breakTime', 0.1, 3, 0.01, 'break time'], ['drainTime', 0.2, 6, 0.05, 'drain time'], 'cooldown', 'castAnim'],
  'The travelling window': [
    ['sheetSpan', 3, 30, 0.1, 'window length'],
    ['crestSeat', 0.05, 0.95, 0.01, 'crest seat in it'],
    ['sheetTail', 0, 8, 0.05, 'tail pinned behind'],
    ['sheetWidth', 1, 20, 0.1, 'width'],
    ['sheetHeight', 0, 0.5, 0.005, 'height off the floor'],
    ['sheetFill', 0, 1, 0.01, 'fill'],
    ['sheetRound', 0, 1, 0.01, 'rectangular → elliptical'],
    ['sheetEdge', 0.01, 1, 0.01, 'waterline feather'],
    ['sheetRagged', 0, 1, 0.01, 'waterline raggedness'],
    ['sheetRaggedScale', 0.05, 4, 0.01, 'raggedness scale'],
    ['sheetOpacity', 0, 1, 0.01, 'opacity'],
    ['contactFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The swell (mirror pairs)': [
    ['swellAmpA', 0, 1, 0.005, 'amp A'],
    ['swellAmpB', 0, 1, 0.005, 'amp B — pairs A'],
    ['swellAmpC', 0, 1, 0.005, 'amp C'],
    ['swellAmpD', 0, 1, 0.005, 'amp D — pairs C'],
    ['swellLengthA', 0.2, 20, 0.05, 'length A'],
    ['swellLengthB', 0.2, 20, 0.05, 'length B'],
    ['swellLengthC', 0.2, 20, 0.05, 'length C'],
    ['swellLengthD', 0.2, 20, 0.05, 'length D'],
    ['swellSpeedA', 0, 8, 0.05, 'speed A'],
    ['swellSpeedB', 0, 8, 0.05, 'speed B'],
    ['swellSpeedC', 0, 8, 0.05, 'speed C'],
    ['swellSpeedD', 0, 8, 0.05, 'speed D'],
    ['swellAngleA', -3.2, 3.2, 0.01, 'bearing A'],
    ['swellAngleB', -3.2, 3.2, 0.01, 'bearing B'],
    ['swellAngleC', -3.2, 3.2, 0.01, 'bearing C'],
    ['swellAngleD', -3.2, 3.2, 0.01, 'bearing D'],
    ['steepness', 0, 1.2, 0.01, 'Gerstner cusps'],
    ['chop', 0, 0.4, 0.001, 'chop'],
    ['chopScale', 0.05, 6, 0.01, 'chop scale'],
    ['chopSpeed', 0, 4, 0.01, 'chop drift'],
    ['detail', 0, 0.1, 0.001, 'normal grain'],
    ['detailScale', 0.5, 20, 0.1, 'grain scale'],
    ['detailSpeed', 0, 4, 0.01, 'grain drift']
  ],
  'The crest': [
    ['crestHeight', 0, 4, 0.01, 'height'],
    ['crestBack', 0.1, 12, 0.05, 'back slope'],
    ['crestFace', 0.02, 3, 0.01, 'front face'],
    ['crestCurl', 0, 3, 0.01, 'forward throw'],
    ['crestWidth', 0.05, 1, 0.01, 'width across'],
    ['crestFeather', 0.01, 1, 0.01, 'end feather'],
    ['crestBreak', 0, 1, 0.01, 'lip raggedness'],
    ['crestBreakScale', 0.1, 6, 0.01, 'raggedness scale'],
    ['crestRise', 0.02, 1, 0.01, 'run to full height'],
    ['crestPeak', 0.2, 4, 0.01, 'height at the break'],
    ['crestCurlPeak', 0.2, 6, 0.01, 'curl at the break'],
    ['crestBreakPeak', 0.2, 6, 0.01, 'raggedness at the break'],
    ['crestOvershoot', 0, 8, 0.05, 'throw past the end']
  ],
  'Ripples': [
    ['rippleAmp', 0, 1, 0.005, 'amplitude'],
    ['rippleSpeed', 0.1, 12, 0.05, 'front speed'],
    ['rippleLength', 0.1, 4, 0.01, 'wavelength'],
    ['rippleWidth', 0.05, 3, 0.01, 'packet width'],
    ['rippleDecay', 0.05, 5, 0.01, 'decay (s)'],
    ['rippleSpread', 0.1, 10, 0.05, 'radial thinning'],
    ['rippleRate', 0, 20, 0.1, 'packets / second'],
    ['rippleSpan', 0, 1, 0.01, 'lateral scatter']
  ],
  'The flow (foam only)': [
    ['flowAngle', -3.2, 3.2, 0.01, 'drift bearing'],
    ['flowSpeed', 0, 6, 0.01, 'drift speed'],
    ['flowRadial', -4, 4, 0.01, 'radial outflow'],
    ['flowRadialFall', 0.1, 12, 0.05, 'outflow falloff'],
    ['flowEddy', 0, 4, 0.01, 'curl swirl'],
    ['flowEddyScale', 0.02, 2, 0.01, 'eddy scale'],
    ['flowEddySpeed', 0, 2, 0.01, 'eddy churn'],
    ['flowGravity', 0, 10, 0.05, 'downhill gain'],
    ['foam', 0, 1, 0.01, 'foam'],
    ['foamScale', 0.5, 16, 0.05, 'foam speckle'],
    ['foamSharp', 0.2, 4, 0.01, 'foam sharpness'],
    ['foamCrest', 0, 3, 0.01, 'seeded by the lip'],
    ['foamSpeed', 0, 3, 0.01, 'seeded by speed'],
    ['foamGateLow', 0, 6, 0.01, 'calm below (m/s)'],
    ['foamGateHigh', 0.1, 10, 0.05, 'frothed above (m/s)']
  ],
  'Shading': [
    ['poolDepth', 0, 3, 0.01, 'depth under the plane'],
    ['depthTint', 0, 10, 0.01, 'absorption / metre'],
    ['translucency', 0, 4, 0.01, 'backlit front face'],
    ['ambient', 0, 1, 0.01, 'ambient floor'],
    ['specular', 0, 6, 0.01, 'specular'],
    ['shininess', 4, 256, 1, 'gloss'],
    ['fresnel', 0, 3, 0.01, 'fresnel'],
    ['envIntensity', 0, 3, 0.01, 'reflection'],
    ['skyIntensity', 0, 3, 0.01, 'sky fallback'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['normalEps', 0.005, 0.3, 0.001, 'normal step'],
    ['colorDeep', 'body'],
    ['colorShallow', 'thin water'],
    ['colorFoam', 'froth'],
    ['colorSpec', 'highlight'],
    ['colorSky', 'sky fallback']
  ],
  'The caustic net': [
    ['netReach', 0.2, 3, 0.01, 'reach (× half-width)'],
    ['netHeight', 0.002, 0.2, 0.001, 'height off the floor'],
    ['netDepth', 0, 4, 0.01, 'water crossed (m)'],
    ['netDepthCrest', 0, 3, 0.01, 'extra per m of crest'],
    ['netIor', 1.01, 2, 0.001, 'index of refraction'],
    ['netDispersion', 0, 0.4, 0.005, 'chromatic spread'],
    ['netStep', 0.02, 0.4, 0.005, 'Hessian tap step'],
    ['netAbsorb', 0, 2, 0.01, 'absorption / metre'],
    ['netFoldFloor', 0.01, 1, 0.005, 'fold floor'],
    ['netThreshold', 0, 4, 0.01, 'black-water threshold'],
    ['netGain', 0, 3, 0.01, 'gain'],
    ['netSharp', 0.1, 4, 0.01, 'sharpness'],
    ['netRolloff', 0, 2, 0.01, 'soft clip'],
    ['netPenumbra', 0.02, 1, 0.01, 'edge penumbra'],
    ['netWash', 0, 1, 0.005, 'lit pool between filaments'],
    ['netFringeAt', 0, 6, 0.01, 'fringe hand-over'],
    ['netEmissive', 0, 5, 0.01, 'emissive'],
    ['netOpacity', 0, 1, 0.01, 'opacity'],
    ['netDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['netBreakGain', 0.2, 6, 0.01, 'gain at the break'],
    ['colorNet', 'filaments'],
    ['colorFringe', 'fold crest'],
    ['colorWash', 'pool light']
  ],
  'Droplets, mist & glints': [
    ['sprayRate', 0, 900, 1, 'droplet rate'],
    ['spraySize', 0.005, 0.5, 0.005, 'droplet size'],
    ['spraySpeed', 0, 20, 0.1, 'droplet speed'],
    ['sprayLifetime', 0.05, 4, 0.01, 'droplet lifetime'],
    ['sprayGravity', -50, 0, 0.1, 'droplet gravity'],
    ['mistRate', 0, 400, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistTurbulence', 0, 3, 0.01, 'mist turbulence'],
    ['glintRate', 0, 400, 1, 'glint rate'],
    ['glintSize', 0.005, 0.4, 0.005, 'glint size'],
    ['glintSpeed', 0, 20, 0.1, 'glint speed'],
    ['glintLifetime', 0.05, 4, 0.01, 'glint lifetime'],
    ['glintGravity', -50, 0, 0.1, 'glint gravity'],
    ['glintGlow', 0, 6, 0.01, 'glint glow'],
    ['colorSpray*', 'Droplet colour'],
    ['colorMist*', 'Mist colour'],
    ['colorGlint*', 'Glint colour']
  ],
  'Marks on the floor': [
    ['wetRate', 0.05, 4, 0.05, 'marks / metre'],
    ['wetRadius', 0.2, 8, 0.05, 'mark radius'],
    ['wetLife', 0.5, 20, 0.1, 'mark lifetime'],
    ['wetIntensity', 0, 3, 0.01, 'mark intensity'],
    ['colorWetA', 'soaked stone'],
    ['colorWetB', 'drying tide line']
  ],
  'The break': [
    ['burstSize', 0.2, 12, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstSpray', 0, 800, 1, 'burst droplets'],
    ['burstGlints', 0, 400, 1, 'burst glints'],
    ['burstRipples', 0, 8, 1, 'ripple packets'],
    ['shockRadius', 0.5, 20, 0.1, 'shockwave radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 1, 0.005, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst crest'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorFlash', 'screen flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
