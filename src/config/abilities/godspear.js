/* ================================================================== */
/* GODSPEAR — the lumen school's line cast, and the school's thesis    */
/* ================================================================== */
/**
 * A colonnade of slanted volumetric shafts standing along the aimed line, lit
 * one after another as a window sweeps down the rank, with the scene's own dust
 * catching fire as it drifts through them and a caustic net running along the
 * floor underneath the burning end.
 *
 * **The trick is real in-scattering, and the read is the anisotropy.** The
 * brightness of a shaft is the Henyey–Greenstein phase function of the angle
 * between the view ray and the *shaft's own axis*, integrated over the segment
 * of that ray which lies inside the cone. Look across a shaft and it is a soft
 * pale cone; walk round until you are looking up one of them and it is roughly
 * eight times brighter. Nothing else in the sandbox has that behaviour, and it
 * is the single thing that makes light read as *light in air* rather than as a
 * translucent solid someone has left standing in the room. The slider is
 * `anisotropy`, it is the first thing to drag, and it is the ability.
 *
 * The two consequences that follow from that, and which are the reason the
 * block below is shaped the way it is:
 *
 *  1. **The shafts must slant.** `shaftTilt` mixes the shaft's own up-vector
 *     from world +Y toward the scene's key-light direction. At 0 the rank is a
 *     row of vertical spotlights, the camera never gets near their axes, and
 *     the phase function never pays out. At 1 they lie over with the stage's
 *     own sun, and the orbit camera crosses their axes twice a lap. Ship it
 *     high.
 *  2. **The band on the floor is not a decal.** `bounce` is the fraction of the
 *     light that lands which comes back at the eye, and it is evaluated by the
 *     same integral, at the point where the view ray actually terminated, with
 *     the same radial falloff, the same canopy gaps and the same axial
 *     extinction the air above it has. Drag `gobo` with the clock stopped and
 *     the leaf-shadows on the floor change with the gaps in the air, because
 *     there is one field and not two. A `DecalType.SCORCH` under the foot would
 *     have been three lines and it would have been a sticker.
 *
 * **The dust is the scene's dust.** `dustGain`, `dustTint` and `dustSwell`
 * drive the `world/DustMotes.js` cloud that is already in the room — the same
 * 2600 motes that drift past when nothing is being cast. They are not copied,
 * re-emitted or shadowed by a second system; the ability hands the dust shader
 * the rank's feet and the shaft profile, and each mote evaluates the same
 * irradiance function `LightShaft#irradianceAt()` evaluates on the CPU. Turn
 * `dustGain` to zero mid-cast and the shafts empty out in front of you.
 *
 * `shaftMote` is therefore **zero on purpose**: it is the library's own hashed
 * dust lattice inside the shaft, it is very good, and using it here would be
 * the second dust system the brief exists to forbid. It is left as a slider
 * because a shaft cast somewhere the scene's dust does not reach still wants
 * something in it.
 *
 * Four beats: **sweep** (travel — the lit window runs from the caster's feet to
 * the far end, the caustic front running with it), **flood** (impact — the
 * whole colonnade lights at once and holds for `lifetime`), **retract** (the
 * window closes back down onto the impact point) and **out**.
 *
 * A cast captures one seed. Every metre below is re-resolved inside the update
 * loop, on a zero-length frame included — pause with **P** mid-sweep and drag
 * `shaftLength` and the whole rank grows out of the floor around you.
 */
export const godspear = {
  /* --- the cast --- */
  range: 24.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 21.0, // metres/second the lit window sweeps down the rank
  lifetime: 2.4, // seconds the flooded colonnade holds
  fadeTime: 1.9, // seconds the window takes to close onto the impact point
  cooldown: 1.7,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the rank --- */
  shaftCount: 7, // shafts in the colonnade (hard ceiling 8)
  shaftSpan: 1.0, // how much of the cast line the rank covers, as a fraction
  shaftScatter: 0.32, // metres of hashed slop off each shaft's nominal place
  shaftLengthJitter: 0.16, // ±fraction on a shaft's length
  shaftRadiusJitter: 0.22, // ±fraction on both of its radii

  /* --- one shaft --- */
  shaftLength: 11.5, // metres, mouth to foot
  shaftRadiusMouth: 0.42, // metres where it enters — narrow, it is a source
  shaftRadiusFoot: 1.45, // metres where it lands. Differs, so it is a cone
  shaftTilt: 0.88, // 0 vertical · 1 lying over with the scene's key light
  shaftPad: 1.4, // how much wider than the shaft its bounding hull is

  /* --- the medium. `anisotropy` is the ability; read the header. --- */
  steps: 30, // marching samples along the view ray (compile-time cap 48)
  jitter: 0.9, // 0..1 dither on the first sample — this is what kills banding
  density: 0.66, // per metre, the in-scattering coefficient
  extinct: 0.052, // 1/metres down the shaft: the beam loses energy on the way
  soft: 0.5, // widens the gaussian core. A falloff, NOT an edge
  axialCurve: 0.6, // how the medium thins toward the mouth
  axialMouth: 0.44, // 0..1 density at the mouth. Zero cuts the shaft off flat
  anisotropy: 0.74, // -0.95..0.95 Henyey-Greenstein g. THE slider
  contact: 0.8, // metres of feather where the shaft meets standing geometry

  /* --- the canopy the light came through --- */
  gobo: 0.46, // 0..1 how much of the shaft the gaps eat
  goboScale: 0.52, // cycles per metre, across the shaft
  goboBias: 0.2, // bigger = more open sky
  goboDrift: 0.09, // radians/second the canopy stirs

  /* --- the shaft's own dust lattice --- */
  shaftMote: 0.0, // ZERO ON PURPOSE — the scene's own motes do this job

  /* --- the band on the floor, produced by the same integral --- */
  bounce: 1.15, // how much of the landed light comes back at the eye
  poolSoft: 0.82, // widens the band's gaussian
  landBand: 0.62, // metres either side of the foot plane that count

  /* --- the beats --- */
  intensity: 1.2, // master gain on the shafts
  sweepWidth: 0.3, // 0..1 of the rank lit at once while the window travels
  floodTime: 0.22, // 0..1 of the hold spent opening the window to the whole rank
  retract: 0.72, // 0..1 how far the window closes again over the fade

  colorMouth: '#fff6dc', // where the shaft enters
  colorFoot: '#ffd48a', // where it lands — warmer, it has lost its blue
  colorMote: '#fffdf2', // the in-shaft lattice (unused while `shaftMote` is 0)
  colorPool: '#ffe4ac', // the band on the ground

  /* --- the dust the room already has --- */
  // These three drive `world/DustMotes.js` itself. Nothing is emitted, nothing
  // is copied: the motes already drifting past evaluate the rank's irradiance
  // per-mote in their own vertex shader.
  dustGain: 6.5, // alpha multiplier on a mote sitting on a shaft's centre line
  dustTint: 0.85, // 0..1 how far a lit mote's colour is pulled to `colorDust`
  dustSwell: 1.9, // extra point size at full irradiance
  colorDust: '#fff2cf', // what a mote inside the shaft burns

  /* --- the caustic net on the floor --- */
  // Light that came through a stirring canopy is not evenly distributed once it
  // lands: it folds, and the folds are the net. It runs in a lane down the cast
  // line with its front locked to the same sweep the shafts are lit by.
  netWidth: 2.5, // metres, half-width of the lane
  netFeather: 1.0, // metres of soft edge on the lane
  netBack: 2.2, // metres behind the front the net survives
  netAhead: 3.6, // metres ahead of it
  netDepth: 1.25, // metres of medium between the folding surface and the floor
  netIor: 1.34, // refractive index of that medium; the shader gets 1 - 1/n
  netDispersion: 0.07, // 0..1 how far R and B sit either side of G
  netStep: 0.085, // metres between the Hessian taps — the net's finest detail
  netAbsorb: 0.12, // 1/metres of extinction down the column
  netFoldFloor: 0.24, // keeps 1/|det| finite; the widest a filament may get
  netThreshold: 1.08, // compression under this is flat, and black
  netGain: 0.62,
  netSharp: 1.3, // exponent on the surviving compression
  netRolloff: 0.22, // soft clip on the peak
  netAmp: 0.15, // metres of relief in the folding surface
  netCellScale: 0.6, // cells per metre
  netCellRatio: 1.63, // the second lattice's scale, as a multiple of the first
  netCellJitter: 0.85, // 0..1 how far a feature point wanders in its cell
  netDriftAngle: 0.65, // radians, the bearing the lattice drifts on
  netDriftSpeed: 0.14, // cells per second
  netBoil: 0.85, // radians per second the feature points orbit
  netRidgeMix: 0.13, // 0..1 of the direct worley-difference net
  netRidgeScale: 2.2, // how tight a direct vein is
  netRidgePower: 6.0, // the exponent on it
  netPenumbra: 0.4, // 0..1 of the reach over which the projector's edge dies
  netEmissive: 1.15,
  netOpacity: 1.0,
  netWash: 0.13, // the lit ground between the filaments
  netFringeAt: 1.6, // where on the fold the colour hands over to the fringe
  netDepthFade: 0.5, // metres of soft fade against standing geometry
  netHeight: 0.02, // metres the quad floats above the floor
  colorNet: '#ffe6b0', // the filaments
  colorFringe: '#ffffff', // the very top of a fold
  colorWash: '#5c4a2c', // the general light between them

  /* --- ash: floor dust kicked up where the band lands --- */
  // The one particle system, and it is *not* the shaft's dust. It is grit
  // lifted off the stone by the band, and each batch is tinted by
  // `LightShaft#irradianceAt()` sampled at the point it leaves from — the CPU
  // mirror of the field the motes read on the GPU.
  ashRate: 34, // particles/second
  ashSize: 0.055,
  ashSpeed: 0.9, // metres/second
  ashLifetime: 2.6, // seconds
  ashRise: 0.55, // metres/second of buoyancy
  ashTurbulence: 0.5,
  ashSpread: 1.5, // metres across the band they are born over
  colorAshA: '#fff4d8',
  colorAshB: '#ffd68e',
  colorAshC: '#8a6a3c',
  colorAshD: '#1a140c',

  /* --- the landing --- */
  burstSize: 2.4, // metres — the flare of air where the spear plants
  burstIntensity: 2.6,
  colorBurstA: '#ffffff',
  colorBurstB: '#ffe6ae',
  colorBurstC: '#c98a3a',
  castFlash: 0.16, // screen flash as the sweep leaves the caster
  colorCastFlash: '#fff3d6',
  impactFlash: 0.34, // screen flash on landing
  colorFlash: '#fff8e4',
  impactShake: 0.22, // camera shake amplitude on landing. Light is not heavy
  shakeDuration: 0.5, // seconds
  rumble: 0.05, // continuous shake while the window sweeps

  /* --- dynamic light --- */
  lightIntensity: 16.0,
  lightRadius: 15.0,
  lightColor: '#ffe3ab',
  lightHeight: 1.5, // metres above the band the light rides at
  lightFlicker: 0.1, // 0..1 depth of the slow breath
  lightFlickerSpeed: 0.6 // breaths per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Godspear.
 *
 * Start in **The medium** and drag `anisotropy` from -0.9 to +0.9 while
 * orbiting. That is the ability; everything else is staging for it. After that,
 * `shaftTilt` in **The rank** decides whether the camera can ever get near an
 * axis, and `dustGain` in **The room's dust** decides whether the shafts have
 * anything in them.
 *
 * `shaftMote` is in **The medium** and ships at zero. Turning it up gives the
 * shaft the library's own hashed dust lattice as well as the room's — which is
 * two dust systems, and looks it.
 */
export const godspearSchema = {
  'The cast': [
    ['range', 5, 45, 0.1, 'max range'],
    ['minRange', 0, 14, 0.1, 'min range'],
    ['speed', 4, 90, 0.5, 'sweep speed'],
    ['lifetime', 0.2, 10, 0.05, 'flood hold'],
    ['fadeTime', 0.2, 8, 0.05, 'retract time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The rank': [
    ['shaftCount', 1, 8, 1, 'shafts'],
    ['shaftSpan', 0.05, 2, 0.01, 'rank span × cast'],
    ['shaftScatter', 0, 3, 0.01, 'placement slop (m)'],
    ['shaftLengthJitter', 0, 1, 0.01, 'length jitter'],
    ['shaftRadiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['shaftTilt', 0, 1, 0.01, 'tilt toward the sun'],
    ['shaftPad', 1, 3, 0.01, 'hull padding']
  ],
  'The shaft': [
    ['shaftLength', 1, 30, 0.05, 'length (m)'],
    ['shaftRadiusMouth', 0.02, 6, 0.01, 'mouth radius (m)'],
    ['shaftRadiusFoot', 0.02, 8, 0.01, 'foot radius (m)'],
    ['intensity', 0, 5, 0.01, 'intensity'],
    ['colorMouth', 'at the mouth'],
    ['colorFoot', 'at the foot']
  ],
  'The medium': [
    ['anisotropy', -0.95, 0.95, 0.005, 'anisotropy (g)'],
    ['density', 0, 3, 0.01, 'in-scattering / m'],
    ['extinct', 0, 0.6, 0.001, 'extinction (1/m)'],
    ['soft', 0.02, 3, 0.01, 'core width'],
    ['axialCurve', 0.05, 4, 0.01, 'axial curve'],
    ['axialMouth', 0, 1, 0.01, 'density at the mouth'],
    ['contact', 0.02, 4, 0.01, 'soft intersection (m)'],
    ['steps', 4, 48, 1, 'march samples'],
    ['jitter', 0, 2, 0.01, 'sample dither'],
    ['shaftMote', 0, 2, 0.01, 'in-shaft lattice (0 = off)'],
    ['colorMote', 'in-shaft lattice']
  ],
  'The canopy': [
    ['gobo', 0, 1, 0.01, 'gap depth'],
    ['goboScale', 0.02, 3, 0.01, 'gap cycles / m'],
    ['goboBias', -1, 1, 0.005, 'open sky'],
    ['goboDrift', -1, 1, 0.005, 'canopy stir (rad/s)']
  ],
  'The band on the floor': [
    ['bounce', 0, 4, 0.01, 'bounce back'],
    ['poolSoft', 0.02, 3, 0.01, 'band width'],
    ['landBand', 0.02, 4, 0.01, 'band depth (m)'],
    ['colorPool', 'band colour']
  ],
  'The beats': [
    ['sweepWidth', 0.02, 1, 0.005, 'lit window'],
    ['floodTime', 0.01, 1, 0.005, 'flood-open share'],
    ['retract', 0, 1, 0.01, 'retract depth']
  ],
  "The room's dust": [
    ['dustGain', 0, 20, 0.05, 'brightness in a shaft'],
    ['dustTint', 0, 1, 0.01, 'colour pull'],
    ['dustSwell', 0, 6, 0.01, 'size in a shaft'],
    ['colorDust', 'lit mote colour']
  ],
  'The caustic net': [
    ['netWidth', 0.1, 10, 0.05, 'lane half-width (m)'],
    ['netFeather', 0.02, 5, 0.01, 'lane feather (m)'],
    ['netBack', 0, 20, 0.05, 'survives behind (m)'],
    ['netAhead', 0, 20, 0.05, 'survives ahead (m)'],
    ['netDepth', 0, 6, 0.01, 'medium depth (m)'],
    ['netIor', 1.001, 2.4, 0.001, 'refractive index'],
    ['netDispersion', 0, 1, 0.005, 'dispersion'],
    ['netStep', 0.005, 0.5, 0.001, 'tap spacing (m)'],
    ['netAbsorb', 0, 2, 0.005, 'absorption (1/m)'],
    ['netFoldFloor', 0.005, 1, 0.005, 'fold floor'],
    ['netThreshold', 0, 4, 0.01, 'fold threshold'],
    ['netGain', 0, 3, 0.01, 'fold gain'],
    ['netSharp', 0.05, 4, 0.01, 'fold sharpness'],
    ['netRolloff', 0, 2, 0.01, 'peak rolloff'],
    ['netAmp', 0, 1, 0.005, 'surface relief (m)'],
    ['netCellScale', 0.02, 3, 0.01, 'cells / m'],
    ['netCellRatio', 0.1, 4, 0.01, 'second lattice ×'],
    ['netCellJitter', 0, 1, 0.01, 'cell jitter'],
    ['netDriftAngle', -3.2, 3.2, 0.01, 'drift bearing (rad)'],
    ['netDriftSpeed', -2, 2, 0.005, 'drift (cells/s)'],
    ['netBoil', 0, 4, 0.01, 'boil (rad/s)'],
    ['netRidgeMix', 0, 1, 0.005, 'direct vein mix'],
    ['netRidgeScale', 0.05, 8, 0.01, 'vein tightness'],
    ['netRidgePower', 0.1, 16, 0.1, 'vein exponent'],
    ['netPenumbra', 0.02, 1, 0.01, 'edge falloff'],
    ['netEmissive', 0, 4, 0.01, 'emissive'],
    ['netOpacity', 0, 2, 0.01, 'opacity'],
    ['netWash', 0, 1, 0.005, 'wash between filaments'],
    ['netFringeAt', 0, 5, 0.01, 'fringe handover'],
    ['netDepthFade', 0.01, 3, 0.01, 'depth fade (m)'],
    ['netHeight', 0.002, 0.3, 0.001, 'float above floor (m)'],
    ['colorNet', 'filaments'],
    ['colorFringe', 'fold fringe'],
    ['colorWash', 'wash']
  ],
  Ash: [
    ['ashRate', 0, 300, 1, 'ash / second'],
    ['ashSize', 0.005, 0.4, 0.005, 'ash size'],
    ['ashSpeed', 0, 6, 0.01, 'ash speed (m/s)'],
    ['ashLifetime', 0.2, 10, 0.05, 'ash lifetime (s)'],
    ['ashRise', -2, 4, 0.01, 'ash rise'],
    ['ashTurbulence', 0, 3, 0.01, 'ash turbulence'],
    ['ashSpread', 0, 6, 0.05, 'born across (m)'],
    ['colorAsh*', 'Ash colour']
  ],
  'The landing': [
    ['burstSize', 0.1, 10, 0.05, 'flare radius (m)'],
    ['burstIntensity', 0, 8, 0.05, 'flare intensity'],
    ['castFlash', 0, 1.5, 0.01, 'cast flash'],
    ['impactFlash', 0, 1.5, 0.01, 'impact flash'],
    ['impactShake', 0, 2, 0.01, 'impact shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)'],
    ['rumble', 0, 1, 0.005, 'sweep rumble'],
    ['colorBurstA', 'flare core'],
    ['colorBurstB', 'flare body'],
    ['colorBurstC', 'flare rim'],
    ['colorCastFlash', 'cast flash'],
    ['colorFlash', 'impact flash']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 10, 0.05, 'light height (m)'],
    ['lightFlicker', 0, 1, 0.01, 'breath depth'],
    ['lightFlickerSpeed', 0, 6, 0.01, 'breaths / second'],
    ['lightColor', 'light colour']
  ]
};
