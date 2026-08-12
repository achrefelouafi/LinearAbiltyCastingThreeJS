/* ================================================================== */
/* WEBLINE — Web Line                                                  */
/* ================================================================== */
/**
 * A drag-line is thrown down the aimed lane, bites, and an orb web spins
 * itself out across the lane on four sagging guy-lines.
 *
 * **What every number in here is for.** The web is a *graph* — a node is the
 * pair of integers `(ring, spoke)` and nothing else, ring −1 being the hub —
 * and every metre it has is a uniform read by the vertex shader on the frame it
 * changes. `radius`, `squash`, `droop`, `depth` and `slack` re-span a web that
 * is already hanging, film included, because the film is a Coons patch over the
 * same four strand curves the strand mesh draws.
 *
 * The membrane is the half of the block worth reaching for first. `filmFill`
 * decides how many faces carry film at all — **never take it to 1**, because
 * the film is a grazing-angle effect and panels that flare need dark panels to
 * flare against. `grazePower` is how narrow the rim of visibility is, and
 * `filmBands` is how many times round the four-stop gradient the interference
 * walks between head-on and edge-on.
 *
 * A cast captures one number, a seed, and some timestamps. Nothing else.
 */
export const webline = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 42.0, // how fast the drag-line pays out, metres/second
  cooldown: 1.1,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  spinTime: 0.9, // seconds the web takes to spin itself out
  holdTime: 1.8, // seconds it hangs finished before it starts to go
  fadeTime: 1.2, // seconds the tear takes

  /* --- where the drag-line leaves the caster --- */
  handHeight: 1.26, // metres above the floor
  handForward: 0.5, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)

  /* --- where the web hangs --- */
  hubHeight: 2.15, // metres above the floor the hub sits
  hubShort: 0.6, // metres short of the aim point the web stands
  lean: 0.22, // radians the disc tips back off vertical, so it catches light

  /* --- the graph. Two integers per node; everything else is a uniform --- */
  rings: 5, // rings of chords outside the hub, whole number
  spokes: 13, // radials, whole number
  radius: 3.4, // metres to the outer ring
  squash: 0.86, // 1 circular, < 1 an ellipse lying down
  ringCurve: 1.42, // > 1 crowds the rings toward the rim, as a real web does
  ringJitter: 0.14, // unitless, fraction of a ring's radius
  spokeJitter: 0.24, // unitless, fraction of a spoke's spacing
  twist: 0.3, // radians of shear per unit radius fraction
  droop: 0.42, // metres the whole disc sags at the rim
  depth: 0.34, // metres of out-of-plane node scatter

  /* --- the strands --- */
  slack: 0.1, // sag as a FRACTION of a strand's own span — not a fixed drop
  sway: 0.045, // metres of breeze, out of plane
  swayRate: 1.6, // radians/second
  strandWidth: 0.022, // metres
  widthJitter: 0.36, // +/- fraction
  chordWidth: 0.7, // multiplier on chords, so the radials read as the frame
  strandOpacity: 1.0,
  strandGlow: 1.15,
  silkPower: 22.0, // Kajiya-Kay exponent — the band of light across the threads
  silkGain: 1.7,
  coreBias: 0.55, // how much brighter a thread's spine is than its edge
  colorStrand: '#e9e2cd', // the thread itself
  colorSilk: '#ffffff', // its fibre highlight

  /* --- the membrane: the part everybody forgets --- */
  dish: 0.085, // metres each panel bellies between its four threads
  grazePower: 2.8, // higher is a thinner rim of visibility
  filmOpacity: 0.6,
  filmBands: 2.4, // times round the gradient, head-on to edge-on
  filmShift: 0.72, // per-face offset along it, so neighbours never band in step
  filmSheen: 0.85,
  filmSheenPower: 34.0,
  filmFill: 0.76, // 0..1 of the faces that carry film. Never 1 — see the header
  tearBias: 0.7, // 1 tears the rim first, 0 tears evenly
  filmGlow: 1.0,
  colorFilmA: '#a8ead9', // head-on, where the film barely exists
  colorFilmB: '#cdd4ff',
  colorFilmC: '#ffd9ae',
  colorFilmD: '#8ba6c6', // edge-on, where the interference is deepest

  /* --- the spinning --- */
  growFeather: 0.2, // 0..1 width of the spinning front
  orderScatter: 0.28, // 0 the film fills ring by ring, 1 at random

  /* --- the snap: what the web does the moment it takes the hit --- */
  snapSway: 0.42, // metres of extra shiver at the catch, out of plane
  snapRate: 11.0, // radians/second that shiver runs at
  snapDecay: 3.4, // per second the shiver dies away
  snapFlash: 1.1, // extra film glow while it is shivering

  /* --- the tear --- */
  tearSlack: 0.22, // extra sag as the threads let go, fraction of a span
  tearDroop: 1.4, // extra metres the whole disc sinks as it comes down
  tearFilm: 0.55, // fraction of the fade by which the film has gone entirely

  /* --- the guy-lines: real catenaries onto floor anchors --- */
  guys: 4, // anchor lines, whole number, 0..4 (one role each)
  guyThreads: 2, // parallel filaments per guy — a real frame thread is doubled
  guySpread: 0.05, // metres between those parallel filaments
  guyReach: 0.62, // fraction beyond the rim node the floor anchor sits
  guySplay: 1.7, // metres fore/aft the anchors alternate
  guyFloor: 0.02, // metres above the floor the anchors are pinned
  guySlack: 0.55, // metres of droop at mid-span before it goes taut
  guyCurve: 1.7, // 1 is rope, 3 is heavy chain, 0.01 is a parabola
  guySwing: 0.05, // metres of lateral sway
  guySwingSpeed: 1.2, // radians/second of that sway
  guyTaut: 0.88, // 0..1 the sag is pulled out of once the web is spun
  guyLead: 0.32, // fraction of the spin the guys are laid over, before the disc
  guyDim: 0.85, // how much dimmer a guy is than the web it holds up

  /* --- the guy ribbon (a `filamentLook()`, spelled out as sliders) --- */
  guyWidth: 0.028, // metres, half-width of the core ribbon
  guyGlowWidth: 4.6, // halo half-width, × the core
  guyGlowOpacity: 0.3,
  guyJitter: 0.05, // metres of lateral kink — silk is smooth, so nearly none
  guyJitterScale: 0.9, // kinks per metre
  guyOctaves: 2, // 1..5
  guyJitterFalloff: 0.5,
  guyCrawl: 0.5, // how fast the kinks slide along, per second
  guyPinch: 0.22, // 0..1 of the path the kink eases in over at each end
  guyRestrike: 2.5, // whole re-shapes per second — slow: this is not lightning
  guyFlicker: 0.04, // depth of the whole-bundle stutter
  guyFlickerSpeed: 8.0,
  guyStrandFlash: 0.12, // per-filament blink
  guyCoreSharp: 3.4, // exponent on the core's edge falloff
  guyGlowFalloff: 2.4,
  guySoftFade: 0.5, // metres of depth fade against the opaque scene
  guyOpacity: 0.95,
  guyGlow: 1.15,
  colorGuyCore: '#fffaf0', // the spine of a guy
  colorGuyInner: '#e6dcbe',
  colorGuyOuter: '#b9ad86',
  colorGuyHalo: '#2c2a1c', // the wide, dim atmosphere round it

  /* --- silk motes: the drag-line on the way out, then dust in the air --- */
  dragRate: 3.2, // motes paid out per metre of drag-line travel
  silkRate: 34.0, // motes shed by the standing web, particles/second
  silkSize: 0.05,
  silkSpeed: 0.7,
  silkLifetime: 1.8,
  silkRise: 0.25, // upward drift, metres/second
  silkTurbulence: 0.55,
  colorSilkA: '#fffdf4',
  colorSilkB: '#eee6cd',
  colorSilkC: '#c6bb98',
  colorSilkD: '#5c563f',

  /* --- dust: what the web has already caught, shaken loose --- */
  dustRate: 22.0, // particles/second
  dustSize: 0.55,
  dustSpeed: 0.5,
  dustLifetime: 2.6,
  dustRise: 0.18,
  dustOpacity: 0.09,
  colorDustA: '#6e6a58',
  colorDustB: '#5d5a4b',
  colorDustC: '#4a483d',
  colorDustD: '#2b2a24',

  /* --- chaff: torn fibre, thrown only when the web lets go --- */
  chaffTear: 90, // fibres thrown at the moment of the tear
  chaffRate: 18.0, // and shed continuously while it comes down
  chaffSize: 0.07,
  chaffSpeed: 2.4,
  chaffLifetime: 1.5,
  chaffGravity: -4.5, // metres/second² — silk falls slowly
  colorChaffA: '#fffaf0',
  colorChaffB: '#ded4b6',
  colorChaffC: '#a99f80',
  colorChaffD: '#4c4837',

  /* --- the catch --- */
  burstSize: 1.5, // the puff of air where the drag-line bites, metres
  burstIntensity: 0.9,
  dustRingRadius: 2.2, // dust knocked off the floor under the anchor, metres
  dustRingLife: 1.4,
  dustRingIntensity: 0.5,
  colorBurstA: '#cfc7a8',
  colorBurstB: '#efe7cd',
  colorBurstC: '#fffdf4',
  colorDustRingA: '#6d6754',
  colorDustRingB: '#a89f80',
  catchFlash: 0.05, // screen flash as it bites — small, this is not an explosion
  colorCatchFlash: '#efe7cd',
  impactShake: 0.22,
  shakeDuration: 0.5,
  rumble: 0.012, // continuous shake while the drag-line pays out

  /* --- dynamic light --- */
  lightIntensity: 9.0,
  lightRadius: 12.0,
  lightColor: '#d8e0c8',
  lightPulse: 0.25, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 2.1
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Web Line.
 *
 * Start in **The membrane**. Drag `filmFill` from 0 to 1 while orbiting and
 * watch the whole idea appear and then destroy itself: at 0 the web is thread
 * and nothing else, at 0.76 the panels flare and vanish as the camera swings,
 * and at 1 it is a frosted disc. `grazePower` and `filmBands` are the other two
 * that carry the look.
 *
 * After that, **The graph** — `radius`, `rings` and `spokes` re-span a web that
 * is already hanging, and `slack` is the one that decides whether it reads as a
 * web or as knitting.
 */
export const weblineSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'drag-line speed'],
    ['spinTime', 0.05, 5, 0.01, 'spin time'],
    ['holdTime', 0.05, 8, 0.01, 'hold time'],
    ['fadeTime', 0.05, 5, 0.01, 'tear time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it hangs': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['hubHeight', 0.2, 6, 0.01, 'hub height'],
    ['hubShort', -4, 6, 0.05, 'stand short by'],
    ['lean', -1.2, 1.2, 0.01, 'lean off vertical']
  ],
  'The graph': [
    ['rings', 1, 8, 1, 'rings'],
    ['spokes', 3, 16, 1, 'spokes'],
    ['radius', 0.4, 9, 0.05, 'rim radius'],
    ['squash', 0.2, 1.6, 0.01, 'ellipse squash'],
    ['ringCurve', 0.3, 3, 0.01, 'ring crowding'],
    ['ringJitter', 0, 0.6, 0.01, 'ring jitter'],
    ['spokeJitter', 0, 1, 0.01, 'spoke jitter'],
    ['twist', -2, 2, 0.01, 'shear'],
    ['droop', -2, 4, 0.01, 'disc sag'],
    ['depth', 0, 2, 0.01, 'out-of-plane scatter']
  ],
  'The strands': [
    ['slack', 0, 0.5, 0.005, 'sag / span'],
    ['sway', 0, 0.6, 0.005, 'breeze'],
    ['swayRate', 0, 8, 0.05, 'breeze rate'],
    ['strandWidth', 0.002, 0.15, 0.001, 'thread width'],
    ['widthJitter', 0, 1, 0.01, 'width jitter'],
    ['chordWidth', 0.1, 3, 0.01, 'chord width ×'],
    ['strandOpacity', 0, 2, 0.01, 'thread opacity'],
    ['strandGlow', 0, 4, 0.01, 'thread glow'],
    ['silkPower', 2, 90, 0.5, 'fibre highlight'],
    ['silkGain', 0, 6, 0.01, 'fibre gain'],
    ['coreBias', 0, 3, 0.01, 'spine bias'],
    ['colorStrand', 'thread'],
    ['colorSilk', 'fibre highlight']
  ],
  'The membrane': [
    ['filmFill', 0, 1, 0.01, 'faces with film'],
    ['filmOpacity', 0, 2, 0.01, 'film opacity'],
    ['grazePower', 0.2, 10, 0.05, 'grazing sharpness'],
    ['filmBands', 0.2, 8, 0.05, 'interference bands'],
    ['filmShift', 0, 3, 0.01, 'per-panel offset'],
    ['dish', -0.5, 0.5, 0.005, 'panel belly'],
    ['filmSheen', 0, 4, 0.01, 'sheen'],
    ['filmSheenPower', 2, 120, 1, 'sheen tightness'],
    ['tearBias', 0, 1, 0.01, 'tear the rim first'],
    ['filmGlow', 0, 4, 0.01, 'film glow'],
    ['colorFilm*', 'Film interference']
  ],
  'Spinning, snap & tear': [
    ['growFeather', 0.01, 1, 0.01, 'spinning front'],
    ['orderScatter', 0, 1, 0.01, 'fill order scatter'],
    ['snapSway', 0, 2, 0.01, 'catch shiver'],
    ['snapRate', 0, 40, 0.1, 'shiver rate'],
    ['snapDecay', 0.1, 20, 0.05, 'shiver decay'],
    ['snapFlash', 0, 5, 0.01, 'shiver flash'],
    ['tearSlack', 0, 1, 0.005, 'let-go sag'],
    ['tearDroop', 0, 6, 0.01, 'let-go drop'],
    ['tearFilm', 0.05, 1, 0.01, 'film gone by']
  ],
  'The guy-lines': [
    ['guys', 0, 4, 1, 'anchor lines'],
    ['guyThreads', 1, 4, 1, 'threads per guy'],
    ['guySpread', 0, 0.4, 0.005, 'thread spacing'],
    ['guyReach', 0, 3, 0.01, 'anchor reach'],
    ['guySplay', -6, 6, 0.05, 'fore/aft splay'],
    ['guyFloor', 0, 1, 0.005, 'anchor height'],
    ['guySlack', 0, 4, 0.01, 'catenary droop'],
    ['guyCurve', 0.01, 4, 0.01, 'catenary curve'],
    ['guySwing', 0, 1, 0.005, 'guy sway'],
    ['guySwingSpeed', 0, 8, 0.05, 'guy sway rate'],
    ['guyTaut', 0, 1, 0.01, 'tautness'],
    ['guyLead', 0.05, 1, 0.01, 'laid over'],
    ['guyDim', 0, 2, 0.01, 'guy dim']
  ],
  'The guy ribbon': [
    ['guyWidth', 0.002, 0.2, 0.001, 'width'],
    ['guyGlowWidth', 1, 20, 0.1, 'halo width'],
    ['guyGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['guyJitter', 0, 1, 0.005, 'kink'],
    ['guyJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['guyOctaves', 1, 5, 1, 'octaves'],
    ['guyJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['guyCrawl', -10, 10, 0.05, 'kink crawl'],
    ['guyPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['guyRestrike', 0.2, 40, 0.1, 'restrikes / sec'],
    ['guyFlicker', 0, 1, 0.01, 'stutter'],
    ['guyFlickerSpeed', 1, 60, 1, 'stutter rate'],
    ['guyStrandFlash', 0, 1, 0.01, 'per-thread blink'],
    ['guyCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['guyGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['guySoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['guyOpacity', 0, 2, 0.01, 'opacity'],
    ['guyGlow', 0, 6, 0.01, 'glow'],
    ['colorGuyCore', 'guy core'],
    ['colorGuyInner', 'guy inner'],
    ['colorGuyOuter', 'guy outer'],
    ['colorGuyHalo', 'guy halo']
  ],
  'Silk, dust & chaff': [
    ['dragRate', 0.1, 20, 0.1, 'drag motes / metre'],
    ['silkRate', 0, 400, 1, 'silk rate'],
    ['silkSize', 0.005, 0.4, 0.005, 'silk size'],
    ['silkSpeed', 0, 8, 0.05, 'silk speed'],
    ['silkLifetime', 0.1, 8, 0.05, 'silk lifetime'],
    ['silkRise', -2, 4, 0.01, 'silk rise'],
    ['silkTurbulence', 0, 3, 0.01, 'silk turbulence'],
    ['dustRate', 0, 300, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 3, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['chaffTear', 0, 400, 1, 'fibres at the tear'],
    ['chaffRate', 0, 200, 1, 'fibre rate'],
    ['chaffSize', 0.005, 0.4, 0.005, 'fibre size'],
    ['chaffSpeed', 0, 20, 0.1, 'fibre speed'],
    ['chaffLifetime', 0.1, 5, 0.05, 'fibre lifetime'],
    ['chaffGravity', -30, 2, 0.1, 'fibre gravity'],
    ['colorSilk*', 'Silk colour'],
    ['colorDust*', 'Dust colour'],
    ['colorChaff*', 'Fibre colour']
  ],
  'The catch': [
    ['burstSize', 0.1, 8, 0.05, 'air puff'],
    ['burstIntensity', 0, 3, 0.01, 'puff intensity'],
    ['dustRingRadius', 0.1, 8, 0.05, 'dust ring radius'],
    ['dustRingLife', 0.1, 6, 0.05, 'dust ring life'],
    ['dustRingIntensity', 0, 2, 0.01, 'dust ring intensity'],
    ['catchFlash', 0, 1, 0.005, 'screen flash'],
    ['impactShake', 0, 3, 0.01, 'catch shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake decay'],
    ['rumble', 0, 0.3, 0.001, 'travel rumble'],
    ['colorBurstA', 'puff inner'],
    ['colorBurstB', 'puff mid'],
    ['colorBurstC', 'puff rim'],
    ['colorDustRingA', 'dust ring'],
    ['colorDustRingB', 'dust ring edge'],
    ['colorCatchFlash', 'screen flash']
  ],
  'Light': [
    ['lightIntensity', 0, 60, 0.5, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius'],
    ['lightPulse', 0, 1, 0.01, 'breathing depth'],
    ['lightPulseSpeed', 0, 20, 0.1, 'breathing rate'],
    ['lightColor', 'colour']
  ]
};
