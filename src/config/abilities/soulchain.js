/* ================================================================== */
/* SOULCHAIN — Soul Tether                                             */
/* ================================================================== */
/**
 * A chain of real, discrete links thrown down the aimed line: it pays out
 * sagging, goes taut with a snap, hangs there rattling, and then comes apart
 * one link at a time from the far end back.
 *
 * The block is organised around the three things that are genuinely separate:
 *
 *  1. **the curve** (`chain*`) — a catenary, not a parabola. `chainCurve` is
 *     the shape parameter: 1 is rope, 3 is heavy chain, and the difference is
 *     all at the anchors, where a hanging chain leaves much steeper than a
 *     parabola does. `chainSag` → `chainSagHeld` over `tautTime` is the snap,
 *     and the ease that carries it overshoots, so the sag briefly goes past
 *     `chainSagHeld` and bows the chain *upward* before it settles.
 *  2. **the links** (`link*`, `rattle*`, `iron*`, `soul*`, `ghost*`) — an
 *     instanced field of swept stadium rings threaded along that curve. Their
 *     spacing is derived from the **live arc length** of the curve, so dragging
 *     `chainSag` genuinely re-spaces them and changes how many there are.
 *  3. **the tether** (`tether*`, `fray*`) — two `FilamentPaths` roles sharing
 *     one two-draw-call strip: the spirit thread the links are strung on, and
 *     the frayed ends that whip loose as they break.
 *
 * `linkLength`, `linkWidth` and `linkThickness` are metres of *geometry* rather
 * than uniforms; the ability rehashes them each frame and rebuilds the link
 * mesh when one of them moves, exactly as `GrowthField#syncGeometry` does. They
 * are still live under a paused drag — the rebuild is what makes them live.
 */
export const soulchain = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 32.0, // how fast the far end of the chain travels, metres/second
  lifetime: 1.15, // seconds the chain hangs taut and rattling
  fadeTime: 1.7, // seconds the links take to break, far end back to the hand
  cooldown: 1.0, // seconds before it can be cast again
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the two anchors --- */
  handHeight: 1.32, // metres above the floor the chain leaves the caster at
  handForward: 0.45, // metres in front of the caster
  handSide: 0.3, // metres to the side (+ follows `Ability#side`)
  endHeight: 1.05, // height of the far anchor, metres

  /* --- the catenary --- */
  chainSag: 2.6, // metres of droop at mid-span while the chain is slack
  chainSagHeld: 0.28, // metres of droop once it has gone taut
  chainCurve: 2.9, // 1 is rope, 3 is heavy chain, 0.01 is a parabola
  chainSwing: 0.22, // metres of slow lateral sway
  chainSwingSpeed: 1.7, // radians/second of that sway
  tautTime: 0.34, // seconds the sag takes to collapse

  /* --- the links --- */
  linkLength: 0.42, // metres, end to end along the chain
  linkWidth: 0.2, // metres across the ring
  linkThickness: 0.05, // metres — the diameter of the bar it is bent from
  linkOverlap: 0.44, // fraction of a link its neighbour covers, 0..0.9
  linkTwist: 1.5708, // radians each link is rotated from its neighbour (π/2)
  linkOpacity: 1.0, // master alpha of the whole chain

  /* --- the rattle --- */
  rattleAmp: 0.22, // radians of per-link shiver about the chain axis
  rattleSway: 0.035, // metres of per-link lateral shiver
  rattleRate: 13.0, // shivers per second
  rattleDecay: 1.1, // s⁻¹ the jangle dies at once the chain is taut

  /* --- the iron --- */
  ironRough: 0.44, // roughness of an unpitted face
  ironMetal: 0.85, // metalness, 0..1
  ironPit: 0.6, // depth of the casting pits, 0..1
  ironPitScale: 44.0, // pit features per metre
  ironEnv: 0.8, // environment-map intensity on the iron

  /* --- the soul in the iron --- */
  soulGlow: 2.3, // emissive of the glow inside each ring
  soulInner: 2.6, // how tightly that glow hugs the inner wall; higher = tighter
  soulPulse: 0.7, // depth of the pulse running along the chain, 0..1
  soulPulseScale: 1.6, // pulses along the whole chain
  soulPulseSpeed: 1.1, // pulses per second travelling hand → anchor
  ghostRim: 1.35, // strength of the cold fresnel rim
  ghostRimPower: 3.2, // how thin that rim is
  breakGlow: 3.8, // how much hotter a link burns the instant it lets go
  colorIron: '#7a8a9a', // ghost iron
  colorIronDeep: '#2a3038', // the bottom of a casting pit
  colorSoul: '#9affe0', // the glow inside the ring
  colorGhost: '#b8d8e0', // the cold rim on the silhouette
  colorBreak: '#e8fff4', // the flash as a link parts

  /* --- coming apart --- */
  breakRate: 15.0, // links parting per second, far end back toward the hand
  breakSpeed: 3.4, // metres/second a freed link is thrown at
  breakSpread: 0.85, // 0..1 — how wide the cone it is thrown into is
  breakGravity: -11.0, // metres/second² a freed link falls at
  breakSpin: 7.5, // radians/second it tumbles at
  breakLife: 1.15, // seconds a freed link lasts before it is gone

  /* ------------------------------------------------------------------ */
  /* The tether — `FilamentPaths` role 0, path LINK                      */
  /* ------------------------------------------------------------------ */
  tetherCount: 3, // filaments threaded through the links
  tetherSpread: 0.05, // metres between those filaments
  tetherWidth: 0.024, // half-width of the core ribbon, metres
  tetherGlowWidth: 6.0, // halo half-width, × the core width
  tetherGlowOpacity: 0.42, // halo alpha relative to the core
  tetherKink: 0.35, // per-role multiplier on the kink amplitude
  tetherJitter: 0.11, // metres of lateral kink at the coarsest octave
  tetherJitterScale: 1.1, // kinks per metre of path
  tetherOctaves: 3, // 1–5; each halves the amplitude and doubles the rate
  tetherJitterFalloff: 0.5, // amplitude kept per octave
  tetherCrawl: 1.1, // how fast the kinks slide along, per second
  tetherPinch: 0.12, // fraction of the path the kink eases in over at each end
  tetherRestrike: 13.0, // whole re-shapes per second
  tetherFlicker: 0.18, // depth of the whole-bundle brightness stutter
  tetherFlickerSpeed: 22.0, // stutters per second
  tetherStrandFlash: 0.4, // depth of the per-filament blink
  tetherCoreSharp: 4.2, // exponent on the core's edge falloff
  tetherGlowFalloff: 2.2, // the same for the halo
  tetherSoftFade: 0.6, // metres of depth fade against the opaque scene
  tetherTipLength: 0.05, // length of the drawn front, fraction of the path
  tetherTipGlow: 1.6, // extra heat on that front
  tetherOpacity: 0.9, // master alpha of the strip
  tetherGlow: 2.1, // emissive multiplier fed into bloom
  colorTetherCore: '#ffffff', // the centre line of a filament
  colorTetherInner: '#c8fff0',
  colorTetherOuter: '#4ec8a8',
  colorTetherHalo: '#0d3a48', // the wide, dim atmosphere

  /* --- the fray — role 1, path CRACK, at the breaking end --- */
  frayCount: 6, // loose spirit ends whipping off the break
  frayAngle: 0.75, // radians a branch leaves its parent by
  frayLength: 0.55, // branch length as a fraction of its parent's
  frayFalloff: 0.6, // extra shortening per generation
  fraySpread: 0.6, // ± fraction of variation on the angle
  frayStart: 0.15, // earliest point on a parent a fork may happen, 0..1
  fraySag: 0.18, // metres of bow on each fray segment
  frayForkBias: 0.5, // 0..1 — slides the branch/twig split
  frayReach: 1.4, // metres a fray reaches back down the chain
  frayKink: 1.6, // per-role multiplier on the kink amplitude
  frayWidth: 0.6, // per-role multiplier on the ribbon width
  frayDim: 0.85, // per-role brightness multiplier

  /* ------------------------------------------------------------------ */
  /* The snap                                                            */
  /* ------------------------------------------------------------------ */
  snapShake: 0.85, // camera shake when the chain goes taut
  shakeDuration: 0.42, // seconds that shake takes to die
  snapFlash: 0.2, // full-screen flash on the snap
  rumble: 0.018, // continuous shake while the chain is being thrown
  burstSize: 2.2, // the pressure shell at the far anchor, metres
  burstIntensity: 1.3, // brightness of that shell
  shockRadius: 4.5, // the ring that snaps across the floor, metres
  colorBurstA: '#2a4a58', // burst shell
  colorBurstB: '#4ec8a8', // burst body
  colorBurstC: '#c8fff0', // burst filaments
  colorShockA: '#4ec8a8', // body of the shockwave ring
  colorShockB: '#e8fff4', // its crest
  colorSnapFlash: '#9affe0', // the screen flash on the snap

  /* ------------------------------------------------------------------ */
  /* Shards, motes and haze                                              */
  /* ------------------------------------------------------------------ */
  /**
   * Four-stop lifetime gradients as everywhere else, `A` at birth through `D`
   * as it dies. Written out rather than derived from the iron palette so the
   * shards can cool to blue while the links stay grey.
   */
  shardPerBreak: 7, // iron fragments thrown when one link parts
  shardSize: 0.05, // fragment size
  shardSpeed: 4.2, // metres/second they are thrown at
  shardLifetime: 1.1, // seconds one lives
  shardGravity: -15.0, // metres/second²
  colorShardA: '#e8fff4',
  colorShardB: '#9affe0',
  colorShardC: '#4a5a66',
  colorShardD: '#242a30',
  moteRate: 55, // soul embers drifting off the chain, particles/second
  moteSize: 0.05, // mote size
  moteSpeed: 0.8, // metres/second they leave the chain at
  moteLifetime: 2.0, // seconds one lives
  moteRise: 0.85, // upward drift, metres/second
  moteTurbulence: 0.7, // how hard the curl field pushes them around
  colorMoteA: '#ffffff',
  colorMoteB: '#9affe0',
  colorMoteC: '#2f7f78',
  colorMoteD: '#08181f',
  hazeRate: 26, // cold breath hanging under the chain, particles/second
  hazeSize: 0.9, // haze puff size
  hazeSpeed: 0.55, // metres/second it drifts at
  hazeLifetime: 2.6, // seconds one lives
  hazeOpacity: 0.07, // how thick the haze reads
  hazeRise: -0.35, // downward drift, metres/second (it is cold, it sinks)
  colorHazeA: '#4a5f68',
  colorHazeB: '#3a4a55',
  colorHazeC: '#2a3640',
  colorHazeD: '#161d24',

  /* --- dynamic light --- */
  lightIntensity: 16, // the soul light riding the travelling end
  lightRadius: 13, // metres it reaches
  lightColor: '#7fe8d0' // its colour
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Soul Tether.
 *
 * Four controls carry it: `chainSag` (how heavily it hangs, and therefore how
 * many links there are), `linkLength` with `linkOverlap` (how coarse the chain
 * reads), `tautTime` (how violent the snap is) and `breakRate` (how fast it
 * unzips). Drag `chainSag` with the clock stopped and watch the link *count*
 * change — that is the ability's whole trick, and it is one slider.
 */
export const soulchainSchema = {
  'The cast': [
    ['range', 2, 45, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'throw speed'],
    ['lifetime', 0.1, 6, 0.01, 'hold taut'],
    ['fadeTime', 0.1, 6, 0.01, 'break-up time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The anchors': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 5, 0.01, 'far anchor height']
  ],
  'The catenary': [
    ['chainSag', 0, 10, 0.01, 'slack sag (m)'],
    ['chainSagHeld', 0, 3, 0.01, 'taut sag (m)'],
    ['chainCurve', 0.05, 6, 0.01, 'catenary shape'],
    ['chainSwing', 0, 2, 0.01, 'sway (m)'],
    ['chainSwingSpeed', 0, 8, 0.01, 'sway (rad/s)'],
    ['tautTime', 0.02, 2, 0.01, 'snap time (s)']
  ],
  'The links/Geometry': [
    ['linkLength', 0.05, 1.5, 0.005, 'link length (m)'],
    ['linkWidth', 0.02, 1, 0.005, 'link width (m)'],
    ['linkThickness', 0.005, 0.3, 0.001, 'bar diameter (m)'],
    ['linkOverlap', 0, 0.9, 0.01, 'overlap'],
    ['linkTwist', 0, 3.1416, 0.01, 'twist per link (rad)'],
    ['linkOpacity', 0, 1, 0.01, 'opacity']
  ],
  'The links/Rattle': [
    ['rattleAmp', 0, 1.2, 0.01, 'shiver (rad)'],
    ['rattleSway', 0, 0.3, 0.001, 'shiver (m)'],
    ['rattleRate', 0, 40, 0.1, 'shivers / second'],
    ['rattleDecay', 0, 8, 0.01, 'jangle decay (s⁻¹)']
  ],
  'The links/Iron': [
    ['ironRough', 0.02, 1, 0.01, 'roughness'],
    ['ironMetal', 0, 1, 0.01, 'metalness'],
    ['ironPit', 0, 1, 0.01, 'pitting'],
    ['ironPitScale', 2, 120, 0.5, 'pits / metre'],
    ['ironEnv', 0, 3, 0.01, 'env intensity']
  ],
  'The links/The soul inside': [
    ['soulGlow', 0, 8, 0.01, 'inner glow'],
    ['soulInner', 0.2, 10, 0.05, 'glow tightness'],
    ['soulPulse', 0, 1, 0.01, 'pulse depth'],
    ['soulPulseScale', 0, 8, 0.01, 'pulses along the chain'],
    ['soulPulseSpeed', -6, 6, 0.01, 'pulse speed (Hz)'],
    ['ghostRim', 0, 5, 0.01, 'ghost rim'],
    ['ghostRimPower', 0.2, 10, 0.05, 'rim tightness'],
    ['breakGlow', 0, 10, 0.01, 'break flash'],
    ['colorIron', 'iron'],
    ['colorIronDeep', 'pit'],
    ['colorSoul', 'soul'],
    ['colorGhost', 'ghost rim'],
    ['colorBreak', 'breaking link']
  ],
  'Coming apart': [
    ['breakRate', 0.5, 60, 0.5, 'links / second'],
    ['breakSpeed', 0, 20, 0.1, 'throw speed (m/s)'],
    ['breakSpread', 0, 1, 0.01, 'throw cone'],
    ['breakGravity', -40, 0, 0.1, 'gravity'],
    ['breakSpin', 0, 30, 0.1, 'tumble (rad/s)'],
    ['breakLife', 0.1, 5, 0.05, 'link lifetime (s)']
  ],
  'The tether/Filaments': [
    ['tetherCount', 0, 12, 1, 'filaments'],
    ['tetherSpread', 0, 1, 0.005, 'spread (m)'],
    ['tetherWidth', 0.002, 0.3, 0.001, 'ribbon width (m)'],
    ['tetherGlowWidth', 1, 20, 0.1, 'halo width'],
    ['tetherGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['tetherCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['tetherGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['tetherTipLength', 0.005, 0.5, 0.005, 'front length'],
    ['tetherTipGlow', 0, 8, 0.05, 'front glow'],
    ['tetherSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['tetherOpacity', 0, 2, 0.01, 'opacity'],
    ['tetherGlow', 0, 8, 0.01, 'glow']
  ],
  'The tether/Kink & flicker': [
    ['tetherKink', 0, 3, 0.01, 'kink multiplier'],
    ['tetherJitter', 0, 2, 0.005, 'kink amplitude (m)'],
    ['tetherJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['tetherOctaves', 1, 5, 1, 'octaves'],
    ['tetherJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['tetherCrawl', -20, 20, 0.1, 'kink crawl'],
    ['tetherPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['tetherRestrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['tetherFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['tetherFlickerSpeed', 1, 120, 1, 'stutter rate'],
    ['tetherStrandFlash', 0, 1, 0.01, 'filament blink']
  ],
  'The tether/Colour': [
    ['colorTetherCore', 'core'],
    ['colorTetherInner', 'inner'],
    ['colorTetherOuter', 'outer'],
    ['colorTetherHalo', 'halo']
  ],
  'The tether/The fray': [
    ['frayCount', 0, 12, 1, 'loose ends'],
    ['frayReach', 0, 6, 0.05, 'reach (m)'],
    ['frayAngle', 0, 2, 0.01, 'branch angle (rad)'],
    ['frayLength', 0.05, 1, 0.01, 'branch length'],
    ['frayFalloff', 0.05, 1, 0.01, 'generation falloff'],
    ['fraySpread', 0, 2, 0.01, 'angle spread'],
    ['frayStart', 0, 1, 0.01, 'earliest fork'],
    ['fraySag', 0, 1, 0.01, 'segment bow (m)'],
    ['frayForkBias', 0, 1, 0.01, 'fork bias'],
    ['frayKink', 0, 4, 0.01, 'kink multiplier'],
    ['frayWidth', 0, 3, 0.01, 'width multiplier'],
    ['frayDim', 0, 2, 0.01, 'brightness']
  ],
  'The snap': [
    ['snapShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['snapFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'throw rumble'],
    ['burstSize', 0.2, 10, 0.05, 'burst size (m)'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['shockRadius', 0.5, 20, 0.1, 'shockwave radius (m)'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorSnapFlash', 'snap flash colour']
  ],
  'Shards & motes': [
    ['shardPerBreak', 0, 40, 1, 'shards / break'],
    ['shardSize', 0.005, 0.5, 0.005, 'shard size'],
    ['shardSpeed', 0, 25, 0.1, 'shard speed'],
    ['shardLifetime', 0.1, 5, 0.05, 'shard lifetime'],
    ['shardGravity', -50, 0, 0.1, 'shard gravity'],
    ['moteRate', 0, 500, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorShard*', 'Shard colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Cold haze': [
    ['hazeRate', 0, 300, 1, 'haze rate'],
    ['hazeSize', 0.05, 4, 0.01, 'haze size'],
    ['hazeSpeed', 0, 8, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 8, 0.05, 'haze lifetime'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['hazeRise', -3, 3, 0.01, 'haze rise'],
    ['colorHaze*', 'Haze colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
