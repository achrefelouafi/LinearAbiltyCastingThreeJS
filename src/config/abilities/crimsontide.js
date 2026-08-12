/* ================================================================== */
/* CRIMSON TIDE — blood · line                                         */
/* ================================================================== */
/**
 * A wave of blood surges down the aimed line, curls, breaks, and soaks away.
 *
 * The block is long because the ability is a **heightfield**, and a heightfield
 * has genuinely more dimensions than a bolt does: four directional swells, a
 * chop octave, a crest profile, a flow field, a congealing skin and a froth
 * threshold are all separate measurements and every one of them is authored
 * here (I5). Nothing below is derived from anything else above it.
 *
 * Three groups are worth reaching for first:
 *
 *  - **the crest** (`crestHeight`, `crestBack`, `crestFace`, `crestCurl`) — the
 *    silhouette. `crestBack / crestFace` is the whole read: a symmetric bump is
 *    a swell, and a bump whose face is an eighth as long as its back is a wave
 *    about to break. Every other slider in the file is decoration next to that
 *    ratio.
 *  - **the flow band** (`crustForm`, `crustBreak`) — the two surface speeds in
 *    metres/second between which the black skin dies and the froth is seeded.
 *    Both the crust and the foam read them, which is the one place in this
 *    block where sharing *is* the design.
 *  - **the sheet** (`sheetLead`, `sheetTail`, `sheetWidth`) — how much water
 *    exists in front of, behind and either side of the crest. The wave is not
 *    a fixed plane the crest slides across: the sheet is re-cut every frame to
 *    exactly the run the surge has covered, so the crest is always at its own
 *    leading edge.
 *
 * **Low emission on purpose.** `emissive` is 0 and `glow` sits below 1. Blood
 * is not a light source; if this cast reads at night it reads by specular off a
 * curling silhouette, which is why `specular` and `shininess` are high and why
 * `translucency` matters more than any colour picker here.
 */
export const crimsontide = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 15.0, // how fast the surge travels, metres/second — deliberately slow
  breakTime: 0.95, // seconds the crest spends curling over and collapsing
  drainTime: 2.6, // seconds the sheet takes to soak into the floor
  cooldown: 1.1,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the sheet ---------------------------------------------------- */
  // The plane is re-cut every frame from these three numbers plus the distance
  // the surge has covered, so a paused wave re-cuts itself when they move.
  sheetWidth: 7.2, // metres across the line the water spans
  sheetLead: 2.6, // metres of water standing in FRONT of the crest
  sheetTail: 2.0, // metres of water standing behind the caster
  sheetHeight: 0.06, // metres the mean plane floats above the floor
  sheetFill: 1.0, // 0..1 of the half-extent the water reaches; the drain rides this
  sheetRound: 0.35, // 0 rectangular footprint, 1 elliptical
  sheetEdge: 0.16, // 0..1 of the field over which the waterline fades out
  sheetRagged: 0.42, // 0..1 how ragged that waterline is
  sheetRaggedScale: 1.1, // cycles per metre of the raggedness
  sheetOpacity: 1.0,
  contactFade: 0.22, // metres of soft fade where the sheet meets standing geometry

  /* --- the swell: four directional waves ---------------------------- */
  // A, B and C run roughly downrange; D crosses them, which is what stops the
  // surface reading as corduroy.
  swellAmpA: 0.13, // metres
  swellAmpB: 0.075,
  swellAmpC: 0.04,
  swellAmpD: 0.028,
  swellLengthA: 6.4, // metres, crest to crest
  swellLengthB: 3.4,
  swellLengthC: 1.9,
  swellLengthD: 1.05,
  swellSpeedA: 2.4, // metres/second
  swellSpeedB: 1.7,
  swellSpeedC: 1.1,
  swellSpeedD: 0.7,
  swellAngleA: 0.0, // radians, in the sheet's own frame (0 = downrange)
  swellAngleB: 0.42,
  swellAngleC: -0.55,
  swellAngleD: 1.9,
  steepness: 0.62, // 0 sine, 1 Gerstner cusps; blood is thick, so it cusps

  /* --- chop and grain ----------------------------------------------- */
  chop: 0.05, // metres of high-frequency displacement
  chopScale: 1.9, // cycles per metre
  chopSpeed: 0.5, // metres/second the chop field drifts
  detail: 0.02, // metres — fragment-only; lives entirely in the normal
  detailScale: 8.5, // cycles per metre
  detailSpeed: 1.1,

  /* --- ripples (impacts ring the sheet) ------------------------------ */
  rippleAmp: 0.22, // metres at strength 1
  rippleSpeed: 3.6, // metres/second the front travels
  rippleLength: 1.15, // metres, crest to crest inside the packet
  rippleWidth: 0.85, // metres of the gaussian envelope
  rippleDecay: 1.1, // seconds to 1/e
  rippleSpread: 3.0, // metres over which it also thins with radius

  /* --- the flow field ------------------------------------------------ */
  // Give the surface somewhere to flow or the crust never breaks and the froth
  // never seeds — both of them are functions of speed and nothing else.
  flowAngle: 0.0, // radians, the bulk drift's bearing in the sheet's frame
  flowSpeed: 1.6, // metres/second of bulk drift
  flowRadial: 0.9, // metres/second outward at the centre
  flowRadialFall: 5.0, // metres to 1/e
  flowEddy: 0.7, // metres/second of curl swirl
  flowEddyScale: 0.34, // cycles per metre
  flowEddySpeed: 0.2, // Hz the eddies churn
  flowGravity: 3.4, // metres/second per unit of surface slope — the coupling

  /* --- the congealing skin ------------------------------------------- */
  // Blood clots where it stops moving. Coverage is 1 − smoothstep(crustForm,
  // crustBreak, speed), so the back of the sheet skins over black while the
  // crest, which is the fastest thing on it, stays wet and open.
  crust: 0.55, // 0..1 master; 0 skips the whole block and its fill cost
  crustForm: 0.55, // m/s below which the skin is unbroken
  crustBreak: 2.4, // m/s above which there is none — also the foam's speed gate
  crustFormTime: 0.55, // seconds before the first skin has chilled
  crackScale: 1.6, // cycles per metre across the flow
  crackStretch: 5.5, // how many times longer features are along it
  crackWidth: 0.22, // 0..1 of the field — the seam's width
  crustAdvect: 1.0, // 0..1 how strongly the pattern is carried by the flow
  crustPeriod: 2.2, // seconds before the flow map resets
  crustBump: 0.55, // 0..1 how much the skin roughens the normal
  seamGlow: 0.35, // how bright a crack between two clots is — kept low
  meltGlow: 0.2, // glow of the bare liquid between the plates

  /* --- froth ---------------------------------------------------------- */
  foam: 0.6, // 0..1 master
  foamScale: 7.0, // cycles per metre of the speckle
  foamSharp: 1.7,
  foamCrest: 1.4, // how much the breaking lip seeds it
  foamSpeed: 0.45, // how much surface speed seeds it

  /* --- the crest ------------------------------------------------------ */
  crestHeight: 1.35, // metres at the peak of the surge
  crestBack: 3.0, // metres — the long back slope's 1/e length
  crestFace: 0.24, // metres — the short front face's 1/e length
  crestCurl: 0.72, // metres of forward throw per metre of height
  crestWidth: 0.78, // 0..1 of the half-extent across the wave
  crestFeather: 0.34, // 0..1 of that, over which the ends die away
  crestBreak: 0.4, // 0..1 how ragged the lip is
  crestBreakScale: 1.5, // cycles per metre along the lip
  crestRise: 0.42, // 0..1 of the run over which the crest reaches full height
  crestPeak: 1.45, // × crestHeight at the moment it curls over
  crestCurlPeak: 2.1, // × crestCurl at that same moment
  crestBreakPeak: 2.2, // × crestBreak at that same moment
  crestOvershoot: 1.4, // metres the lip throws past the end of the line

  /* --- shading -------------------------------------------------------- */
  poolDepth: 0.35, // metres of liquid under the mean plane
  depthTint: 3.2, // Beer-Lambert density, per metre — blood is opaque fast
  translucency: 1.6, // backlight through the folded lip — the read of the cast
  ambient: 0.16, // floor on the wrapped diffuse
  specular: 2.4, // the other read: a wave you see by its highlight
  shininess: 96, // Blinn-Phong exponent
  fresnel: 1.25,
  envIntensity: 0.55,
  skyIntensity: 0.3,
  emissive: 0.0, // blood is not a light source. Leave this at zero.
  glow: 0.85, // sub-unity on purpose — see the block comment
  normalEps: 0.04, // metres — the finite-difference step for the normal

  colorDeep: '#24030a', // the body, looking straight down through it
  colorShallow: '#8a0f18', // the thin water at the waterline and the lip
  colorCrust: '#180207', // the congealed skin
  colorSeam: '#5a0710', // a crack between two clots
  colorHot: '#3a050a', // the bare liquid showing through
  colorFoam: '#ff4a4a', // the froth on the breaking lip
  colorSpec: '#ffbcbc', // the highlight
  colorSky: '#2a1418', // the fallback reflection where the env probe is empty

  /* --- the wet stone the tide leaves --------------------------------- */
  // A GroundField(WET) disc: soaked flagstone, alpha-blended so it comes out
  // genuinely darker than the floor, drying from the edges in.
  wetAlong: 0.62, // 0..1 down the line the puddle is centred
  wetRadius: 4.2, // metres
  wetHeight: 0.012, // metres above the floor
  wetEdge: 0.5, // metres of feather on the tide line
  wetRagged: 0.4, // fraction of the radius the tide line wanders by
  wetRaggedScale: 0.55, // lobes per metre
  wetWarp: 0.9, // metres of domain warp on those lobes
  wetRelief: 0.55, // how hard the puddle field tilts the fake normal
  wetNormalStep: 0.05, // metres between the height taps
  wetAmbient: 0.2,
  wetWrap: 0.5, // 0..1 wraps the terminator round the back
  wetSpecular: 1.6, // soaked stone is shinier than dry stone
  wetGloss: 48, // Blinn exponent
  wetParallax: 0.2, // metres of view-driven offset on the interior detail
  wetCell: 0.7, // metres — the pitch of the standing puddles
  wetLift: 0.02, // metres the film stands proud
  wetDepth: 0.05, // metres the low spots sit down
  wetDetail: 0.7, // 0..1 fine grain
  wetSpeed: 0.5, // radians/second the film ripples
  wetFlow: 0.15, // metres/second the film drifts
  wetWindAngle: 0.0, // radians, in the quad's frame
  wetOpacity: 0.95,
  wetEmissive: 0.5, // the sheen term only — there is nothing glowing here
  wetDepthFade: 0.4, // metres of soft fade against standing geometry
  wetDryDelay: 0.18, // 0..1 of the drain before the stone starts drying
  wetDryTime: 0.72, // 0..1 of the drain the drying takes
  colorWetBase: '#3a3438', // dry flagstone, as this mark sees it
  colorWetEdge: '#c07a80', // the sheen, and the rim of the tide line
  colorWetGlow: '#7a1a22', // the pale tide mark the last of it leaves
  colorWetDeep: '#120a0c', // soaked stone

  /* --- the droplet flock off the lip ---------------------------------- */
  // A Swarm, not a particle system: these are the coherent sheet of spray the
  // lip throws forward and drags along with it, and a flock is the only thing
  // that keeps them together. The ones that fall are particles.
  dropCount: 150, // live agents
  dropSize: 0.13, // metres, nose to tail
  dropAspect: 0.85, // span / length
  dropSizeJitter: 0.55, // ±fraction
  dropLift: 0.35, // metres above the lip the flock's lead sits
  dropRise: 0.9, // metres the lead lofts at mid-run
  dropLatticeX: 9, // cells across the lip
  dropLatticeY: 4, // cells up
  dropLatticeZ: 6, // ranks strung out behind it
  dropSpacingSide: 0.42, // metres between lateral cells
  dropSpacingUp: 0.3, // metres between vertical cells
  dropLag: 0.34, // seconds the back rank trails the lip by
  dropJitter: 0.22, // metres of slop off the cell
  dropChurn: 0.5, // radians/second the formation rolls
  dropBreathe: 0.3, // fraction it swells by
  dropBreatheRate: 2.4, // radians/second
  dropWander: 0.14, // metres of curl drift — keep under half the spacing
  dropWanderScale: 0.7, // features per metre
  dropWanderSpeed: 0.9,
  dropGather: 0.85, // 0 collapses every droplet onto the lip's own path
  dropBank: 0.05, // radians of roll per m/s² of lateral acceleration
  dropBankMax: 1.0, // radians
  dropCurl: 0.25, // how far a droplet bends across its own chord
  dropBillboard: 0.35, // 0 world plate, 1 camera-facing sprite
  dropEdgeStretch: 1.4, // how much an edge-on droplet grows so it stays visible
  dropEdgeGain: 1.2, // emission multiplier when it does
  dropRevealSpread: 0.4, // width of the appear/disappear wave
  dropLit: 1.0, // 1 = wrapped diffuse. Blood droplets are lit, not emissive
  dropTint: 0.25, // where in the gradient the flock sits
  dropTintJitter: 0.3, // ±per-agent walk along it
  dropTintAlong: 0.4, // extra walk from the lip to the tail
  dropOpacity: 1.0,
  dropGlow: 0.5, // sub-unity: these must not bloom
  dropSoftFade: 0.3, // metres of depth feather against solid geometry
  colorDropA: '#c81a28', // at the lip
  colorDropB: '#8a0f18',
  colorDropC: '#4a060d',
  colorDropD: '#24030a', // by the time it is falling behind

  /* --- spray, mist and clots ------------------------------------------ */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as it dies, spelled
   * out per system rather than derived from the sheet's palette — the spray is
   * allowed to stay bright while the mist goes brown.
   */
  sprayRate: 220, // droplets thrown off the lip, particles/second
  spraySize: 0.085,
  spraySpeed: 5.5,
  sprayLifetime: 1.0,
  sprayGravity: -16.0, // metres/second² — heavier than water, and it shows
  colorSprayA: '#ff4a4a',
  colorSprayB: '#c81a28',
  colorSprayC: '#7a0a14',
  colorSprayD: '#2a040a',
  mistRate: 46, // fine red haze standing over the wave
  mistSize: 0.9,
  mistSpeed: 1.0,
  mistLifetime: 2.3,
  mistRise: 0.35, // upward drift, metres/second
  mistOpacity: 0.1,
  mistTurbulence: 0.8,
  colorMistA: '#6e1018',
  colorMistB: '#4a0a12',
  colorMistC: '#2e060c',
  colorMistD: '#180307',
  clotRate: 16, // heavy gobbets rolling off the back of the wave
  clotSize: 0.075,
  clotSpeed: 3.4,
  clotLifetime: 1.5,
  clotGravity: -20.0,
  colorClotA: '#7a0a14',
  colorClotB: '#4a060d',
  colorClotC: '#2a040a',
  colorClotD: '#160205',

  /* --- what the tide leaves on the floor ------------------------------ */
  slickRate: 0.55, // wet marks laid per metre of front travel
  slickRadius: 2.3, // radius of one mark, metres
  slickLife: 5.5, // seconds it lingers
  slickIntensity: 0.85,
  colorSlickA: '#2a0a10', // the soaked stone under the mark
  colorSlickB: '#8a2028', // the froth drying back into a ring

  /* --- the break ------------------------------------------------------- */
  burstSize: 2.4, // the sheet of blood thrown up where it breaks, metres
  burstIntensity: 0.9,
  burstSpray: 220, // extra droplets thrown at the break
  burstClots: 70,
  burstRipples: 5, // ripple packets injected into the sheet at the break
  shockRadius: 5.0, // the ring that runs out across the floor, metres
  impactShake: 0.55,
  shakeDuration: 0.7,
  impactFlash: 0.05, // barely anything — this cast does not flash
  rumble: 0.05, // continuous shake while the surge travels
  colorBurstA: '#4a060d',
  colorBurstB: '#8a0f18',
  colorBurstC: '#ff4a4a',
  colorShockA: '#7a0a14',
  colorShockB: '#c81a28',
  colorFlash: '#5a0810',

  /* --- dynamic light ---------------------------------------------------- */
  // Low and deep. It is here so the wet stone and the curling face have
  // something to specular against, not so the cast glows.
  lightIntensity: 7.5,
  lightRadius: 13.0,
  lightColor: '#c8323c'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Crimson Tide.
 *
 * Reach for `The crest` first — it owns the silhouette, and the silhouette is
 * the ability. `The sheet` decides how much water there is to make it out of;
 * `The flow` decides whether the skin ever cracks. Everything in `Shading` is
 * a second-order refinement on a wave that already reads.
 */
export const crimsontideSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 2, 60, 0.5, 'surge speed'],
    ['breakTime', 0.1, 5, 0.01, 'break duration'],
    ['drainTime', 0.2, 8, 0.01, 'drain duration'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The sheet': [
    ['sheetWidth', 1, 24, 0.1, 'width'],
    ['sheetLead', 0, 10, 0.05, 'water ahead of the crest'],
    ['sheetTail', 0, 10, 0.05, 'water behind the caster'],
    ['sheetHeight', 0, 0.5, 0.005, 'mean plane height'],
    ['sheetFill', 0.05, 1, 0.01, 'waterline'],
    ['sheetRound', 0, 1, 0.01, 'footprint rounding'],
    ['sheetEdge', 0.01, 0.6, 0.005, 'waterline feather'],
    ['sheetRagged', 0, 1, 0.01, 'waterline raggedness'],
    ['sheetRaggedScale', 0.1, 5, 0.01, 'raggedness scale'],
    ['sheetOpacity', 0, 1, 0.01, 'opacity'],
    ['contactFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The swell': [
    ['swellAmpA', 0, 1.2, 0.005, 'amplitude A'],
    ['swellAmpB', 0, 1.2, 0.005, 'amplitude B'],
    ['swellAmpC', 0, 1.2, 0.005, 'amplitude C'],
    ['swellAmpD', 0, 1.2, 0.005, 'amplitude D'],
    ['swellLengthA', 0.2, 20, 0.05, 'wavelength A'],
    ['swellLengthB', 0.2, 20, 0.05, 'wavelength B'],
    ['swellLengthC', 0.2, 20, 0.05, 'wavelength C'],
    ['swellLengthD', 0.2, 20, 0.05, 'wavelength D'],
    ['swellSpeedA', -8, 8, 0.05, 'speed A'],
    ['swellSpeedB', -8, 8, 0.05, 'speed B'],
    ['swellSpeedC', -8, 8, 0.05, 'speed C'],
    ['swellSpeedD', -8, 8, 0.05, 'speed D'],
    ['swellAngleA', -3.2, 3.2, 0.01, 'bearing A'],
    ['swellAngleB', -3.2, 3.2, 0.01, 'bearing B'],
    ['swellAngleC', -3.2, 3.2, 0.01, 'bearing C'],
    ['swellAngleD', -3.2, 3.2, 0.01, 'bearing D'],
    ['steepness', 0, 1.2, 0.01, 'Gerstner cusping']
  ],
  'Chop & grain': [
    ['chop', 0, 0.5, 0.005, 'chop'],
    ['chopScale', 0.1, 8, 0.01, 'chop scale'],
    ['chopSpeed', 0, 4, 0.01, 'chop drift'],
    ['detail', 0, 0.15, 0.001, 'normal detail'],
    ['detailScale', 1, 24, 0.1, 'detail scale'],
    ['detailSpeed', 0, 6, 0.01, 'detail drift']
  ],
  'Ripples': [
    ['rippleAmp', 0, 1.5, 0.005, 'amplitude'],
    ['rippleSpeed', 0.2, 14, 0.05, 'front speed'],
    ['rippleLength', 0.1, 6, 0.01, 'wavelength'],
    ['rippleWidth', 0.1, 5, 0.01, 'packet width'],
    ['rippleDecay', 0.05, 6, 0.01, 'decay to 1/e'],
    ['rippleSpread', 0.2, 14, 0.05, 'radial thinning']
  ],
  'The flow': [
    ['flowAngle', -3.2, 3.2, 0.01, 'drift bearing'],
    ['flowSpeed', 0, 8, 0.01, 'drift speed'],
    ['flowRadial', 0, 8, 0.01, 'radial outflow'],
    ['flowRadialFall', 0.2, 20, 0.1, 'outflow falloff'],
    ['flowEddy', 0, 6, 0.01, 'eddy speed'],
    ['flowEddyScale', 0.02, 3, 0.01, 'eddy scale'],
    ['flowEddySpeed', 0, 3, 0.01, 'eddy churn'],
    ['flowGravity', 0, 12, 0.01, 'downhill flow']
  ],
  'The congealing skin': [
    ['crust', 0, 1, 0.01, 'skin coverage'],
    ['crustForm', 0, 6, 0.01, 'clots below (m/s)'],
    ['crustBreak', 0.05, 12, 0.01, 'melts above (m/s)'],
    ['crustFormTime', 0.05, 6, 0.01, 'first skin (s)'],
    ['crackScale', 0.1, 6, 0.01, 'seams / metre'],
    ['crackStretch', 0.5, 20, 0.1, 'seam stretch'],
    ['crackWidth', 0.01, 0.8, 0.005, 'seam width'],
    ['crustAdvect', 0, 2, 0.01, 'carried by the flow'],
    ['crustPeriod', 0.2, 8, 0.05, 'flow-map period'],
    ['crustBump', 0, 2, 0.01, 'skin relief'],
    ['seamGlow', 0, 4, 0.01, 'seam glow'],
    ['meltGlow', 0, 4, 0.01, 'bare-liquid glow']
  ],
  'Froth': [
    ['foam', 0, 1, 0.01, 'froth'],
    ['foamScale', 0.5, 20, 0.1, 'speckle scale'],
    ['foamSharp', 0.2, 5, 0.01, 'speckle hardness'],
    ['foamCrest', 0, 4, 0.01, 'seeded by the lip'],
    ['foamSpeed', 0, 4, 0.01, 'seeded by speed']
  ],
  'The crest': [
    ['crestHeight', 0, 5, 0.01, 'height'],
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
    ['emissive', 0, 3, 0.01, 'self-lit body'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['normalEps', 0.005, 0.3, 0.001, 'normal step'],
    ['colorDeep', 'body'],
    ['colorShallow', 'thin water'],
    ['colorCrust', 'congealed skin'],
    ['colorSeam', 'seam'],
    ['colorHot', 'bare liquid'],
    ['colorFoam', 'froth'],
    ['colorSpec', 'highlight'],
    ['colorSky', 'sky fallback']
  ],
  'Wet stone': [
    ['wetAlong', 0, 1, 0.01, 'where down the line'],
    ['wetRadius', 0.3, 14, 0.05, 'radius'],
    ['wetHeight', 0, 0.2, 0.001, 'height off the floor'],
    ['wetEdge', 0.02, 3, 0.01, 'tide-line feather'],
    ['wetRagged', 0, 1, 0.01, 'tide-line raggedness'],
    ['wetRaggedScale', 0.05, 4, 0.01, 'raggedness scale'],
    ['wetWarp', 0, 4, 0.01, 'domain warp'],
    ['wetRelief', 0, 3, 0.01, 'relief'],
    ['wetNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['wetAmbient', 0, 1, 0.01, 'ambient floor'],
    ['wetWrap', 0, 1, 0.01, 'terminator wrap'],
    ['wetSpecular', 0, 5, 0.01, 'sheen'],
    ['wetGloss', 1, 160, 1, 'gloss'],
    ['wetParallax', 0, 2, 0.01, 'parallax'],
    ['wetCell', 0.05, 4, 0.01, 'puddle pitch'],
    ['wetLift', 0, 0.3, 0.001, 'film relief'],
    ['wetDepth', 0, 0.6, 0.005, 'low-spot depth'],
    ['wetDetail', 0, 1, 0.01, 'grain'],
    ['wetSpeed', 0, 6, 0.01, 'film ripple rate'],
    ['wetFlow', 0, 3, 0.01, 'film drift'],
    ['wetWindAngle', -3.2, 3.2, 0.01, 'drift bearing'],
    ['wetOpacity', 0, 1, 0.01, 'opacity'],
    ['wetEmissive', 0, 3, 0.01, 'sheen gain'],
    ['wetDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['wetDryDelay', 0, 1, 0.01, 'drying starts at'],
    ['wetDryTime', 0.05, 1.5, 0.01, 'drying takes'],
    ['colorWetBase', 'dry stone'],
    ['colorWetEdge', 'sheen'],
    ['colorWetGlow', 'tide mark'],
    ['colorWetDeep', 'soaked stone']
  ],
  'Droplets off the lip': [
    ['dropCount', 0, 256, 1, 'droplets'],
    ['dropSize', 0.01, 0.8, 0.005, 'size'],
    ['dropAspect', 0.2, 4, 0.01, 'aspect'],
    ['dropSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['dropLift', -1, 3, 0.01, 'lift above the lip'],
    ['dropRise', -2, 6, 0.01, 'loft at mid-run'],
    ['dropLatticeX', 1, 16, 1, 'cells across'],
    ['dropLatticeY', 1, 12, 1, 'cells up'],
    ['dropLatticeZ', 1, 20, 1, 'ranks behind'],
    ['dropSpacingSide', 0.02, 2, 0.01, 'lateral spacing'],
    ['dropSpacingUp', 0.02, 2, 0.01, 'vertical spacing'],
    ['dropLag', 0.02, 2, 0.01, 'rank lag (s)'],
    ['dropJitter', 0, 1, 0.01, 'cell slop'],
    ['dropChurn', -4, 4, 0.01, 'formation roll'],
    ['dropBreathe', 0, 1, 0.01, 'swell'],
    ['dropBreatheRate', 0, 8, 0.01, 'swell rate'],
    ['dropWander', 0, 1, 0.01, 'curl drift'],
    ['dropWanderScale', 0.05, 4, 0.01, 'drift scale'],
    ['dropWanderSpeed', 0, 4, 0.01, 'drift speed'],
    ['dropGather', 0, 1, 0.01, 'gather onto the lip'],
    ['dropBank', 0, 0.5, 0.005, 'bank'],
    ['dropBankMax', 0, 3, 0.01, 'bank limit'],
    ['dropCurl', 0, 1, 0.01, 'droplet curl'],
    ['dropBillboard', 0, 1, 0.01, 'camera facing'],
    ['dropEdgeStretch', 1, 4, 0.01, 'edge-on stretch'],
    ['dropEdgeGain', 0, 6, 0.01, 'edge-on gain'],
    ['dropRevealSpread', 0.02, 1, 0.01, 'reveal width'],
    ['dropLit', 0, 1, 0.01, 'lit vs emissive'],
    ['dropTint', 0, 1, 0.01, 'gradient position'],
    ['dropTintJitter', 0, 1, 0.01, 'gradient jitter'],
    ['dropTintAlong', 0, 1, 0.01, 'gradient along'],
    ['dropOpacity', 0, 1, 0.01, 'opacity'],
    ['dropGlow', 0, 4, 0.01, 'glow'],
    ['dropSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorDrop*', 'Droplet colour']
  ],
  'Spray, mist & clots': [
    ['sprayRate', 0, 900, 1, 'spray rate'],
    ['spraySize', 0.005, 0.5, 0.005, 'spray size'],
    ['spraySpeed', 0, 20, 0.1, 'spray speed'],
    ['sprayLifetime', 0.05, 4, 0.01, 'spray lifetime'],
    ['sprayGravity', -50, 0, 0.1, 'spray gravity'],
    ['mistRate', 0, 400, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistTurbulence', 0, 3, 0.01, 'mist turbulence'],
    ['clotRate', 0, 200, 1, 'clot rate'],
    ['clotSize', 0.005, 0.4, 0.005, 'clot size'],
    ['clotSpeed', 0, 20, 0.1, 'clot speed'],
    ['clotLifetime', 0.1, 5, 0.05, 'clot lifetime'],
    ['clotGravity', -50, 0, 0.1, 'clot gravity'],
    ['colorSpray*', 'Spray colour'],
    ['colorMist*', 'Mist colour'],
    ['colorClot*', 'Clot colour']
  ],
  'Marks on the floor': [
    ['slickRate', 0.05, 4, 0.05, 'marks / metre'],
    ['slickRadius', 0.2, 8, 0.05, 'mark radius'],
    ['slickLife', 0.5, 20, 0.1, 'mark lifetime'],
    ['slickIntensity', 0, 3, 0.01, 'mark intensity'],
    ['colorSlickA', 'soaked stone'],
    ['colorSlickB', 'drying froth']
  ],
  'The break': [
    ['burstSize', 0.2, 12, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstSpray', 0, 800, 1, 'burst spray'],
    ['burstClots', 0, 400, 1, 'burst clots'],
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
