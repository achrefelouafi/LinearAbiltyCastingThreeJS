/* ================================================================== */
/* ABYSSAL CAGE — the slot where colour is a measurement               */
/* ================================================================== */
/**
 * A far cast. A bell of black water heaves out of the floor, and what it leaves
 * standing is a **cage of soap film** — thirty-odd bubbles interlocked on a
 * sphere around the circle, each one draining, marbling and eventually
 * bursting from its own crown.
 *
 * **The trick is thin-film interference, done properly.** The hue of every
 * pixel of film is computed from that film's *thickness* against the *view
 * angle* — `Δ = 2·n·d·cos θₜ`, plus the half-wave the hard front reflection
 * adds, integrated across the visible band against the CIE colour matching
 * functions and converted to sRGB. See `materials/ThinFilmMaterial.js` for the
 * derivation and for what the two wrong versions looked like.
 *
 * **There is therefore no film colour in this block, and that is deliberate.**
 * If you have come here looking for `colorFilm`, the slider you want is
 * `filmThickness` — 320 nm is gold and magenta, 480 nm is blue and silver, 180
 * nm is a bruise, and 60 nm is nearly black. That is not a mapping anybody
 * authored; it is what a film of that thickness does. The four pickers below
 * cover the things that genuinely are authored: the water's body tint under the
 * interference, the glint, the silhouette wash, and what little light a film
 * thinner than a quarter-wave still returns.
 *
 * **The black crown is the tell.** Gravity drains a real film downward, so the
 * top thins first, and when it drops below a quarter-wave every wavelength
 * cancels and the crown goes *black* — the last thing a bubble does before it
 * bursts. Drive `filmDrain` up with a cage standing and you can watch the
 * ceiling of every bubble lose its colour in order.
 *
 * A cast captures one seed and four unitless dice rolls per bubble (a direction
 * on the cage, a size fraction, a decorrelation seed, a pop roll). Every
 * nanometre, metre and second is resolved inside the update loop, zero-length
 * frames included: pause with a cage standing, drag `filmThickness`, and every
 * band on every bubble marches.
 */

import { ShellMode, shellDefaults, shellSchema } from '../../vfx/Shell.js';

export const bubblecage = {
  /* --- the cast --- */
  range: 18.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  zoneRadius: 4.2, // the circle the indicator draws — and the cage's own scale, metres
  speed: 26.0, // how fast the bead of water reaches the point, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats (seconds; scaled by global.lifetime) --------------- */
  bellTime: 0.55, // the water bell heaving up and vanishing again
  holdTime: 3.4, // the cage standing, start to first collapse
  fadeTime: 1.6, // what is left of the cage giving out

  /* --- the cage ------------------------------------------------------ */
  bubbles: 34, // how many bubbles the cage is built from, 1..64
  cageRadius: 0.86, // bubble-centre sphere, × zoneRadius
  bubbleRadius: 0.27, // one bubble, × zoneRadius. Above ~0.3 they interlock,
  //                      which is what makes it read as a cage rather than as
  //                      a handful of balloons hanging in the air
  bubbleScatter: 0.4, // 0..1 spread of the per-bubble size dice
  cageBreathe: 0.05, // radial pulse of the whole cage, × cageRadius
  cageBreatheSpeed: 0.35, // Hz
  cageJostle: 0.18, // tangential slop on one bubble, metres
  cageJostleSpeed: 0.4, // Hz
  cageSquash: 0.72, // vertical scale on the cage sphere. 1 is a ball; below 1
  //                    it settles into a dome resting on the stone, which is
  //                    what stops it reading as a beach ball hanging in the air
  cageLift: 0.12, // metres the whole cage floats above its own footprint

  /* --- one bubble's life --------------------------------------------- */
  bubbleStagger: 0.55, // seconds between the first bubble inflating and the last
  bubbleInflate: 0.34, // seconds one bubble takes to reach full size
  bubbleOvershoot: 0.24, // how far past that size it snaps on the way
  bubbleSwell: 0.1, // extra radius as the film gives out, fraction

  /* --- the film (the trick) ------------------------------------------- */
  filmThickness: 420.0, // NANOMETRES at the foot of the bubble. THE slider.
  filmIor: 1.34, // refractive index of the film. Water is 1.333; pushing it
  //                 toward 2.4 crowds the bands the way an oil slick does
  filmDrain: 0.6, // 0..1 how much thinner the crown is than the foot
  filmDrainSeed: 0.28, // 0..1 of that gradient already present at birth
  filmThinRate: 0.74, // fraction of the whole film lost by the moment it pops
  filmMarble: 0.32, // 0..1 thickness variation from convection in the film
  filmMarbleScale: 2.1, // marbling features per bubble
  filmFlow: 0.28, // Hz the marbling creeps around the film
  filmReflect: 0.06, // normal-incidence reflectance. Water is really 0.02 and
  //                    at 0.02 the film is invisible against the stage; 0.06 is
  //                    the smallest number that reads at twenty metres
  filmFresnel: 3.4, // Schlick exponent — amplitude only, never hue
  filmGain: 9.0, // master on the interference term
  filmSaturation: 1.0, // 0 renders the same physics in grey, which is a
  //                      genuinely useful A/B when tuning the thickness
  filmRim: 0.35, // wash on the silhouette so the cage keeps its shape
  filmRimPower: 3.0,
  filmSheen: 1.5, // the single specular glint
  filmSheenSharp: 90.0, // its tightness. Broad readings turn it to plastic
  filmOpacity: 1.0,
  filmGlow: 1.5, // emissive gain into bloom
  filmSoftFade: 0.35, // metres of depth fade against the opaque scene
  colorFilmBody: '#bfe8ff', // the water's own tint, under the interference
  colorFilmBlack: '#0a1420', // what a film below a quarter-wave still returns
  colorFilmSheen: '#ffffff', // the glint and the retracting rupture rim
  colorFilmRim: '#4fd8d0', // the silhouette wash

  /* --- the rupture ---------------------------------------------------- */
  popTime: 2.2, // seconds after its own birth a bubble's film gives way
  popSpread: 1.8, // seconds of scatter on that, so they go one at a time
  popCollapse: 0.9, // 0..1 how far the fade phase hauls every deadline in
  popBurstTime: 0.16, // seconds the hole takes to eat one bubble
  popJitter: 0.7, // radians the rupture wanders off the crown
  popRimWidth: 0.12, // radians of retracting rim behind the hole
  popFlash: 1.7, // brightness of that rim
  popDroplets: 26, // droplets thrown by one bubble bursting
  popMist: 7, // mist puffs from the same
  popFoamLife: 2.4, // seconds the foam mark under a burst lasts
  popFoamRadius: 0.5, // metres
  popFoamIntensity: 0.8,
  colorFoamA: '#cfeef0', // foam body
  colorFoamB: '#6fbfc8', // foam edge

  /* --- the impact ------------------------------------------------------ */
  burstSize: 2.6, // the water burst on the frame the bell lands, metres
  burstIntensity: 1.2,
  colorBurstA: '#2c6a86',
  colorBurstB: '#8fdcea',
  colorBurstC: '#ffffff',
  impactShake: 0.5,
  shakeDuration: 0.6, // seconds it decays over
  impactFlash: 0.12, // full-screen flash, 0..2
  colorFlash: '#a8e4f0',
  rippleRadius: 3.4, // the ring on the floor, metres
  rippleLife: 1.6, // seconds
  rippleIntensity: 1.0,
  colorRippleA: '#3a86a0',
  colorRippleB: '#d8f6ff',

  /* --- the pool the cage stands in (vfx/GroundField.js, POOL) ---------- */
  poolRadius: 1.05, // × zoneRadius
  poolHeight: 0.02, // metres above the floor the quad lies at
  poolEdge: 0.3, // metres of feather on the front
  poolRagged: 0.24, // how far the rim wanders, fraction of the radius
  poolRaggedScale: 0.8, // lobes per metre
  poolWarp: 0.45, // metres of domain warp on those lobes
  poolDepth: 0.16, // metres — how deep the standing water reads
  poolLift: 0.05, // metres — the meniscus at the rim
  poolThickness: 0.05, // metres — that rim's width
  poolFlow: 0.22, // metres/second the surface drifts at
  poolWind: 0.6, // radians — the bearing that drift runs along
  poolCell: 0.55, // surface features per metre
  poolSpeed: 1.0, // Hz the surface noise crawls at
  poolDetail: 0.6, // 0..1 how much of that surface is drawn
  poolNormalStep: 0.06, // metres between the height taps that fake the normal
  poolWrap: 0.45, // 0..1 wraps the terminator round the back
  poolSpecular: 0.75,
  poolGloss: 42.0, // Blinn exponent
  poolRelief: 0.5,
  poolAmbient: 0.3,
  poolOpacity: 0.85,
  poolEmissive: 0.6,
  poolGrow: 0.28, // seconds the pool takes to spread to full radius
  poolDry: 1.0, // 0..1 how far the fade dries it back from the rim
  colorPoolBase: '#0d3242', // the water itself
  colorPoolEdge: '#a9e8f2', // the meniscus and the sheen
  colorPoolGlow: '#3fd0c8', // anything emissive in it
  colorPoolDeep: '#04141c', // the bottom

  /* --- droplets thrown by a burst -------------------------------------- */
  dropRate: 40, // droplets/second shed by the standing cage
  dropSize: 0.06,
  dropSpeed: 3.4,
  dropLifetime: 1.3,
  dropGravity: -14.0, // metres/second²
  colorDropA: '#eafbff',
  colorDropB: '#9fe0f0',
  colorDropC: '#4f9fc0',
  colorDropD: '#1c4a60',

  /* --- the mist that hangs inside the cage ----------------------------- */
  mistRate: 26, // puffs/second
  mistSize: 0.75,
  mistSpeed: 0.6,
  mistLifetime: 2.2,
  mistRise: 0.35, // metres/second²
  mistOpacity: 0.4,
  colorMistA: '#bfe4ec',
  colorMistB: '#7fb4c4',
  colorMistC: '#40707f',
  colorMistD: '#1b3540',

  /* --- fizz: the small bubbles rising inside the cage ------------------ */
  fizzRate: 55, // motes/second
  fizzSize: 0.05,
  fizzSpeed: 1.1,
  fizzLifetime: 1.8,
  fizzRise: 2.4, // metres/second² — these go up, hard
  fizzTurbulence: 0.6,
  colorFizzA: '#ffffff',
  colorFizzB: '#b6f0ff',
  colorFizzC: '#57c0d8',
  colorFizzD: '#1d5a72',

  /* --- dynamic light --------------------------------------------------- */
  lightIntensity: 6.0, // the standing level; the beats punch it with `lightBoost`
  lightRadius: 15.0,
  lightColor: '#7fd8e8',

  /* --- the bell (vfx/Shell.js, DOME mode, prefix `bell`) --------------- */
  // 44 keys. The RING_TRAIN and SUNDISC members are inert in DOME mode and are
  // left out of the schema on purpose — they land in the editor's trailing
  // "More" folder, which is what it is for.
  ...shellDefaults('bell', ShellMode.DOME, {
    bellRadius: 0.5, // the travelling bead of water, metres
    bellRadiusEnd: 4.6, // the bell at the top of its heave, metres
    bellExpand: 3.2,
    bellHeight: 1.15, // taller than it is wide — water thrown up, not out
    bellLift: 0.02,
    bellDisplace: 0.24,
    bellNoiseScale: 2.2,
    bellNoiseSpeed: 1.1,
    bellFill: 0.22,
    bellRim: 1.5,
    bellRimPower: 2.2,
    bellSeal: 1.8,
    bellSealWidth: 0.14,
    bellDissolve: 1.05,
    bellOpacity: 0.8,
    bellGlow: 1.3,
    bellSoftFade: 0.5,
    bellColorBody: '#10485f',
    bellColorRim: '#8fe0ee',
    bellColorEdge: '#ffffff',
    bellColorCorona: '#3fd0c8'
  })
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Abyssal Cage.
 *
 * Open **The film** and drag `filmThickness` first. Nothing else in this
 * project answers a slider the way that one does — the whole cage changes hue,
 * in the right order, because you moved a distance in nanometres. Then
 * `filmDrain`, which is the black crown, and `filmIor`, which is how tightly
 * the bands crowd.
 *
 * `filmSaturation` at 0 is the honest A/B: the same physics with the colour
 * taken out, so you can see that the *pattern* is doing the work and the hue is
 * only what the pattern is made of.
 *
 * The `bell*` folders come from `shellSchema('bell', ShellMode.DOME)`; the
 * ring-train and sun-disc keys `shellDefaults` also brings in do nothing to a
 * dome and are deliberately unfiled.
 */
export const bubblecageSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['zoneRadius', 1, 12, 0.05, 'cage scale (m)'],
    ['speed', 5, 120, 0.5, 'travel speed'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['bellTime', 0.05, 2, 0.01, 'water bell (s)'],
    ['holdTime', 0.3, 10, 0.05, 'cage standing (s)'],
    ['fadeTime', 0.1, 6, 0.05, 'collapse (s)']
  ],
  'The film': [
    ['filmThickness', 40, 900, 1, 'thickness (nm) — THE slider'],
    ['filmIor', 1.02, 2.6, 0.005, 'refractive index'],
    ['filmDrain', 0, 1, 0.005, 'crown thinning'],
    ['filmDrainSeed', 0, 1, 0.005, 'drainage at birth'],
    ['filmThinRate', 0, 1, 0.005, 'thinning over life'],
    ['filmMarble', 0, 1, 0.005, 'marbling'],
    ['filmMarbleScale', 0.2, 8, 0.05, 'marbling scale'],
    ['filmFlow', 0, 2, 0.01, 'marbling drift (Hz)'],
    ['filmSaturation', 0, 2, 0.01, 'saturation (0 = grey A/B)']
  ],
  'The film/How much light': [
    ['filmReflect', 0.005, 0.4, 0.001, 'normal reflectance'],
    ['filmFresnel', 0.5, 8, 0.05, 'Schlick exponent'],
    ['filmGain', 0, 30, 0.1, 'interference gain'],
    ['filmRim', 0, 2, 0.01, 'silhouette wash'],
    ['filmRimPower', 0.5, 8, 0.05, 'wash tightness'],
    ['filmSheen', 0, 5, 0.01, 'glint'],
    ['filmSheenSharp', 4, 400, 1, 'glint tightness'],
    ['filmOpacity', 0, 1, 0.005, 'opacity'],
    ['filmGlow', 0, 5, 0.01, 'glow'],
    ['filmSoftFade', 0.02, 2, 0.01, 'depth fade (m)']
  ],
  'The film/Colour (the hue is NOT here)': [
    ['colorFilmBody', 'water body tint'],
    ['colorFilmBlack', 'below a quarter-wave'],
    ['colorFilmSheen', 'glint'],
    ['colorFilmRim', 'silhouette wash']
  ],
  'The cage': [
    ['bubbles', 1, 64, 1, 'bubbles'],
    ['cageRadius', 0.2, 1.6, 0.005, 'cage sphere × zone'],
    ['bubbleRadius', 0.05, 0.6, 0.005, 'one bubble × zone'],
    ['bubbleScatter', 0, 1, 0.005, 'size scatter'],
    ['cageSquash', 0.1, 1.4, 0.005, 'squash onto the floor'],
    ['cageLift', -1, 3, 0.01, 'float above the floor (m)'],
    ['cageBreathe', 0, 0.5, 0.005, 'breathe × radius'],
    ['cageBreatheSpeed', 0, 3, 0.01, 'breathe (Hz)'],
    ['cageJostle', 0, 1.5, 0.005, 'jostle (m)'],
    ['cageJostleSpeed', 0, 3, 0.01, 'jostle (Hz)']
  ],
  'The cage/One bubble': [
    ['bubbleStagger', 0, 3, 0.01, 'stagger (s)'],
    ['bubbleInflate', 0.02, 2, 0.01, 'inflate (s)'],
    ['bubbleOvershoot', 0, 1.5, 0.01, 'overshoot'],
    ['bubbleSwell', 0, 0.8, 0.005, 'swell before the pop']
  ],
  'The rupture': [
    ['popTime', 0.1, 8, 0.05, 'film lifetime (s)'],
    ['popSpread', 0, 6, 0.05, 'scatter (s)'],
    ['popCollapse', 0, 1, 0.005, 'collapse on fade'],
    ['popBurstTime', 0.02, 1, 0.005, 'hole opens over (s)'],
    ['popJitter', 0, 3.14, 0.01, 'rupture wander (rad)'],
    ['popRimWidth', 0.01, 1, 0.005, 'retracting rim (rad)'],
    ['popFlash', 0, 6, 0.01, 'rim brightness'],
    ['popDroplets', 0, 120, 1, 'droplets per burst'],
    ['popMist', 0, 60, 1, 'mist per burst'],
    ['popFoamLife', 0.1, 8, 0.05, 'foam mark (s)'],
    ['popFoamRadius', 0.05, 3, 0.01, 'foam radius (m)'],
    ['popFoamIntensity', 0, 2, 0.01, 'foam intensity'],
    ['colorFoamA', 'foam body'],
    ['colorFoamB', 'foam edge']
  ],
  'The impact': [
    ['burstSize', 0.2, 10, 0.05, 'water burst (m)'],
    ['burstIntensity', 0, 3, 0.01, 'burst intensity'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake decay (s)'],
    ['impactFlash', 0, 2, 0.005, 'screen flash'],
    ['rippleRadius', 0.2, 12, 0.05, 'ring radius (m)'],
    ['rippleLife', 0.1, 6, 0.05, 'ring lifetime (s)'],
    ['rippleIntensity', 0, 3, 0.01, 'ring intensity'],
    ['colorBurstA', 'burst body'],
    ['colorBurstB', 'burst rim'],
    ['colorBurstC', 'burst core'],
    ['colorFlash', 'flash colour'],
    ['colorRippleA', 'ring body'],
    ['colorRippleB', 'ring crest']
  ],
  'The pool': [
    ['poolRadius', 0.2, 2.5, 0.01, 'pool × zone'],
    ['poolGrow', 0.02, 3, 0.01, 'spread (s)'],
    ['poolDry', 0, 1, 0.005, 'drying on the fade'],
    ['poolHeight', 0.002, 0.3, 0.002, 'height above floor (m)'],
    ['poolEdge', 0.02, 2, 0.01, 'rim feather (m)'],
    ['poolRagged', 0, 1, 0.005, 'rim wander'],
    ['poolRaggedScale', 0.1, 4, 0.05, 'rim lobes / m'],
    ['poolWarp', 0, 3, 0.01, 'rim warp (m)'],
    ['poolDepth', 0.01, 1.5, 0.005, 'depth (m)'],
    ['poolLift', 0, 0.5, 0.005, 'meniscus (m)'],
    ['poolThickness', 0.005, 0.4, 0.005, 'meniscus width (m)'],
    ['poolFlow', 0, 2, 0.01, 'surface drift (m/s)'],
    ['poolWind', 0, 6.28, 0.01, 'drift bearing (rad)'],
    ['poolCell', 0.05, 3, 0.01, 'surface features / m'],
    ['poolSpeed', 0, 4, 0.01, 'surface crawl (Hz)'],
    ['poolDetail', 0, 1, 0.005, 'detail'],
    ['poolNormalStep', 0.01, 0.4, 0.005, 'normal tap (m)'],
    ['poolWrap', 0, 1, 0.005, 'terminator wrap'],
    ['poolSpecular', 0, 3, 0.01, 'specular'],
    ['poolGloss', 2, 128, 1, 'gloss'],
    ['poolRelief', 0, 2, 0.01, 'relief'],
    ['poolAmbient', 0, 1, 0.005, 'ambient'],
    ['poolOpacity', 0, 1, 0.005, 'opacity'],
    ['poolEmissive', 0, 3, 0.01, 'emissive'],
    ['colorPoolBase', 'water'],
    ['colorPoolEdge', 'meniscus'],
    ['colorPoolGlow', 'emissive'],
    ['colorPoolDeep', 'bottom']
  ],
  'Droplets, mist & fizz': [
    ['dropRate', 0, 400, 1, 'droplet rate'],
    ['dropSize', 0.005, 0.4, 0.005, 'droplet size'],
    ['dropSpeed', 0, 20, 0.1, 'droplet speed'],
    ['dropLifetime', 0.1, 5, 0.05, 'droplet lifetime'],
    ['dropGravity', -40, 0, 0.1, 'droplet gravity'],
    ['mistRate', 0, 300, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 10, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['fizzRate', 0, 400, 1, 'fizz rate'],
    ['fizzSize', 0.005, 0.4, 0.005, 'fizz size'],
    ['fizzSpeed', 0, 10, 0.05, 'fizz speed'],
    ['fizzLifetime', 0.1, 6, 0.05, 'fizz lifetime'],
    ['fizzRise', -2, 8, 0.01, 'fizz rise'],
    ['fizzTurbulence', 0, 3, 0.01, 'fizz turbulence'],
    ['colorDrop*', 'Droplet colour'],
    ['colorMist*', 'Mist colour'],
    ['colorFizz*', 'Fizz colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'standing intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ],
  ...shellSchema('bell', ShellMode.DOME)
};
