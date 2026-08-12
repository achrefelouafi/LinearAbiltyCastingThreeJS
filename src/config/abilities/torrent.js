/* ================================================================== */
/* TORRENT — a cutting jet, and the sheet it throws                    */
/* ================================================================== */
/**
 * A line cast. A thin, high-pressure column of water comes off the caster's
 * hand and walks its contact point down the line, and where it lands it throws
 * a **deflection sheet**.
 *
 * **The trick is that the spray knows which way the surface is facing.** The
 * jet's direction is reflected about the impact surface's normal; the component
 * of that reflection *in* the surface is the axis the sheet runs along, and the
 * component along the normal — exactly reversed by the reflection — is what
 * lifts the crown. The flux is then distributed around the azimuth by the
 * Poisson kernel, which is the only distribution on a circle that conserves
 * both mass and in-plane momentum and has nothing else in it.
 * `materials/DeflectionSheetMaterial.js` has the derivation.
 *
 * The consequences you can see, none of which a radial puff has:
 *
 *  - the fan is **narrow and forward** at a grazing angle and opens toward a
 *    full ring as the jet steepens, so it visibly widens as the contact point
 *    walks in toward the caster;
 *  - the crown only rises when there is normal momentum to reverse, so a
 *    grazing jet lies flat on the deck and a steep one throws a bell;
 *  - `surfaceTilt` and `surfaceRoll` swing the whole thing, sheet and droplets
 *    together, because they are the same three lines of algebra read from two
 *    ends — the sheet draws the density, the droplets sample its inverse CDF.
 *
 * **On `fanConcentration`.** The inviscid in-plane fraction is `sin θ`, and at
 * this cast's own geometry that is about 0.99, which collapses the fan to a
 * seven-degree line. Real jets lose most of that to the splash and the
 * roughness, so `k = sinθ · fanConcentration`. It is a fudge; it is labelled as
 * one; and it is a single scalar on a term that still answers the geometry.
 *
 * A cast captures one seed and a handful of timestamps. Everything with a unit
 * below is resolved inside the update loop, zero-length frames included: pause
 * with the jet standing and drag `surfaceTilt`, and the fan swings.
 */

import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';

export const torrent = {
  /* --- the cast --- */
  range: 15.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 17.0, // how fast the contact point walks down the line, metres/second
  cooldown: 1.1, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats (seconds; scaled by global.lifetime where noted) ---- */
  holdTime: 1.15, // the jet held at full reach after the walk-out
  fadeTime: 0.85, // pressure dropping — the column collapses to a thread
  openTime: 0.12, // seconds the fan takes to reach full extent on contact

  /* --- where the jet leaves the caster ------------------------------- */
  handForward: 0.55, // metres ahead of the origin
  handSide: 0.3, // metres to the side
  handHeight: 1.55, // metres above the floor. THIS is what sets the incidence
  //                    angle, and therefore how wide the fan is

  /* --- the impact surface -------------------------------------------- */
  // Default: the floor, dead flat. These two exist because the whole ability is
  // "the spray answers the normal", and an ability that claims that had better
  // let you move the normal and watch.
  surfaceTilt: 0.0, // radians the surface normal leans off vertical
  surfaceRoll: 0.0, // radians — which way it leans, in the cast's flat frame
  surfaceHeight: 0.03, // metres the sheet sits above the stone (z-fight relief)

  /* --- the fan (the trick) -------------------------------------------- */
  fanConcentration: 0.58, // the loss term on the in-plane momentum. 0 makes the
  //                         spray a perfect ring whatever the angle, 1 is the
  //                         inviscid answer and is far too tight to read
  fanReach: 3.6, // metres the mean bearing carries
  fanPower: 0.85, // how hard reach follows the flux density. 0 = a circle at
  //                  fanReach with the brightness varying; 1 = the outline
  //                  itself is the distribution
  fanCrown: 0.16, // lift off the plate, × reach, × the reversed normal momentum
  fanCrownFall: 1.7, // how fast the sheet comes back down to the surface
  fanFingers: 13.0, // ligaments the unstable rim breaks into
  fanFingerDepth: 0.22, // 0..1 how deep they cut into the outline
  fanFingerScale: 3.2, // hashed features around the rim
  fanFingerSpeed: 4.5, // Hz they crawl
  fanRipple: 0.06, // metres of chop on the sheet's surface
  fanRippleScale: 2.4, // chop features per metre
  fanRippleSpeed: 3.2, // Hz it runs outward
  fanThin: 1.6, // metres over which the sheet halves in thickness
  fanBody: 0.7, // how much body it keeps at all
  fanRimWidth: 0.16, // 0..1 of the reach the collected rim occupies
  fanRimGain: 0.55, // how bright that rim is
  fanFresnel: 2.6, // grazing whitening exponent
  fanSpecular: 0.95,
  fanGloss: 40.0, // Blinn exponent
  fanOpacity: 1.0,
  fanGlow: 1.35, // emissive gain into bloom
  fanSoftFade: 0.3, // metres of depth fade against the opaque scene
  colorSheet: '#1f7f9a', // the water where the sheet is thick
  colorSheetThin: '#0b3a4c', // ... and where it has stretched out
  colorSheetRim: '#d6f6ff', // the collected edge
  colorSheetSpray: '#ffffff', // its specular and crest

  /* --- spray: the streaks that leave along the fan --------------------- */
  sprayRate: 320, // streaks/second while the jet is on
  spraySize: 0.05,
  spraySpeed: 9.5, // metres/second — the jet's own speed, near enough
  spraySpeedVariance: 0.55,
  sprayLifetime: 0.75,
  sprayGravity: -17.0, // metres/second²
  sprayStretch: 2.4, // velocity stretch on a streak
  sprayLift: 0.35, // 0..1 how much of the reversed normal momentum a droplet
  //                   takes with it. 0 keeps the whole spray on the deck
  sprayJitter: 0.18, // radians of scatter on top of the sampled bearing
  colorSprayA: '#ffffff',
  colorSprayB: '#bfeaf6',
  colorSprayC: '#5aa8c4',
  colorSprayD: '#1a4c62',

  /* --- the big drops thrown off the rim -------------------------------- */
  dropRate: 55, // drops/second
  dropSize: 0.1,
  dropSpeed: 5.5,
  dropLifetime: 1.4,
  dropGravity: -16.0,
  colorDropA: '#eafbff',
  colorDropB: '#a4dcec',
  colorDropC: '#4f96b4',
  colorDropD: '#173f52',

  /* --- the atomised haze ------------------------------------------------ */
  mistRate: 90, // puffs/second
  mistSize: 0.55,
  mistSpeed: 1.6,
  mistLifetime: 1.5,
  mistRise: 0.9, // metres/second²
  mistOpacity: 0.35,
  colorMistA: '#d4eef4',
  colorMistB: '#96c2cf',
  colorMistC: '#4f7784',
  colorMistD: '#1e343c',

  /* --- the wet stone (vfx/GroundField.js, WET mode) --------------------- */
  wetRadius: 1.5, // × fanReach
  wetBias: 0.35, // × fanReach the patch is pushed downstream along the fan
  //                 axis. Water soaks into stone isotropically, so the *shape*
  //                 stays a disc; where it is centred is not arbitrary
  wetHeight: 0.014, // metres above the floor the quad lies at
  wetEdge: 0.35, // metres of feather on the front
  wetRagged: 0.3, // how far the rim wanders, fraction of the radius
  wetRaggedScale: 0.9, // lobes per metre
  wetWarp: 0.5, // metres of domain warp on those lobes
  wetDepth: 0.08, // metres — how dark the soak reads
  wetLift: 0.02, // metres of standing ripple
  wetCell: 0.7, // puddle features per metre
  wetFlow: 0.4, // metres/second the ripple drifts
  wetSpeed: 1.4, // Hz the ripple crawls
  wetDetail: 0.7, // 0..1
  wetRelief: 0.45,
  wetNormalStep: 0.05, // metres between the height taps
  wetAmbient: 0.3,
  wetWrap: 0.4,
  wetSpecular: 1.1, // wet stone is shinier than dry stone; this is the read
  wetGloss: 60.0,
  wetOpacity: 0.9,
  wetEmissive: 0.5,
  wetGrow: 0.2, // seconds the patch takes to reach full radius
  wetDry: 1.0, // 0..1 how far the fade dries it back from the rim
  colorWetBase: '#4a5158', // damp stone
  colorWetEdge: '#cfeaf2', // the sheen
  colorWetGlow: '#8fb8c0', // the pale tide mark left by drying
  colorWetDeep: '#171d22', // the soak

  /* --- foam left on the stone ------------------------------------------- */
  foamRate: 3.0, // marks per metre of contact-point travel
  foamRadius: 0.45, // metres
  foamLife: 2.2, // seconds
  foamIntensity: 0.7,
  colorFoamA: '#e2f6fa',
  colorFoamB: '#79b8c8',

  /* --- the impact -------------------------------------------------------- */
  burstSize: 1.5, // the water burst on the frame the jet lands, metres
  burstIntensity: 1.0,
  colorBurstA: '#1c5c74',
  colorBurstB: '#9fdfef',
  colorBurstC: '#ffffff',
  impactShake: 0.35,
  shakeDuration: 0.45, // seconds it decays over
  rumble: 0.11, // sustained shake while the jet is running
  impactFlash: 0.06, // full-screen flash, 0..2
  colorFlash: '#bfeaf6',

  /* --- dynamic light ------------------------------------------------------ */
  lightIntensity: 5.0,
  lightRadius: 12.0,
  lightColor: '#79cfe4',

  /* --- the jet (vfx/Tube.js, STRAIGHT path, prefix `jet`) ----------------- */
  // 79 keys. Thin, hard and barely flared: a cutting jet, not a beam. The
  // FUNNEL/WHIP/VINE/ARC members of the block are inert on a STRAIGHT tube and
  // are left out of the schema on purpose.
  ...tubeDefaults('jet', TubePath.STRAIGHT, {
    jetRadius: 0.11, // half-width where it lands, metres
    jetRadiusNear: 0.16, // ... and at the nozzle. Wider at the nozzle: a free
    //                       jet necks down as it accelerates away
    jetRadiusCurve: 0.55,
    jetFlare: 0.35, // a little belling where it hits
    jetFlareWidth: 0.1,
    jetThrob: 0.09, // pump pulsation
    jetThrobScale: 5.5,
    jetThrobSpeed: 6.0,
    jetWander: 0.04,
    jetWanderScale: 1.4,
    jetWanderSpeed: 1.6,
    jetRipple: 0.22, // the barrel breaking up as it travels
    jetRippleBands: 2.4,
    jetRippleScale: 6.5,
    jetRippleSpeed: 5.5,
    jetStreak: 1.2, // filaments running down the column — this is water
    jetStreakSharp: 0.62,
    jetStreakScale: 9.0,
    jetStreakBands: 3.4,
    jetStreakGlow: 0.8,
    jetFlowSpeed: 16.0, // fast: the surface has to look like it is moving
    jetBands: 0.0,
    jetCoreWidth: 0.42,
    jetCoreFill: 0.6,
    jetCoreSharp: 1.2,
    jetEdgePower: 2.4,
    jetSheathWidth: 1.0,
    jetSheathRim: 1.1,
    jetSheathFill: 0.22,
    jetSheathOpacity: 0.92,
    jetHaloWidth: 1.7,
    jetHaloRim: 3.2,
    jetHaloOpacity: 0.35,
    jetMuzzleGlow: 1.2,
    jetMuzzleLength: 0.07,
    jetTipGlow: 1.1,
    jetTipLength: 0.05,
    jetOpacity: 1.0,
    jetGlow: 1.4,
    jetSoftFade: 0.4,
    jetColorCore: '#e8fbff',
    jetColorInner: '#a9e6f6',
    jetColorOuter: '#2f88a8',
    jetColorHalo: '#0a3244'
  })
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Torrent.
 *
 * Open **The impact surface** and drag `surfaceTilt` first, with the jet
 * standing and the sim paused. The sheet, the crown and every droplet swing
 * together, because they all come off one reflection. `surfaceRoll` then
 * decides which way it swings.
 *
 * `fanConcentration` is the second one to reach for — from 0 (a perfect ring,
 * which is what everybody else's splash is) to 1 (the inviscid answer, a knife
 * of spray). Somewhere near 0.6 is where it reads as pressure.
 *
 * `handHeight` is the sleeper: it is the only thing that sets the incidence
 * angle, so raising it steepens the jet, narrows nothing and *widens* the fan,
 * which is the opposite of what most people guess.
 *
 * The `jet*` folders come from `tubeSchema('jet', TubePath.STRAIGHT)`; the
 * whip, funnel, vine and arc keys `tubeDefaults` also brings in do nothing to a
 * straight tube and are deliberately unfiled.
 */
export const torrentSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'contact walk (m/s)'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['holdTime', 0.05, 6, 0.05, 'jet held (s)'],
    ['fadeTime', 0.05, 4, 0.05, 'pressure drop (s)'],
    ['openTime', 0.01, 1, 0.005, 'fan opens over (s)']
  ],
  'The nozzle': [
    ['handForward', -1, 3, 0.01, 'forward (m)'],
    ['handSide', -2, 2, 0.01, 'side (m)'],
    ['handHeight', 0.2, 6, 0.01, 'height (m) — sets the angle']
  ],
  'The impact surface': [
    ['surfaceTilt', 0, 1.2, 0.005, 'normal tilt (rad)'],
    ['surfaceRoll', 0, 6.28, 0.01, 'tilt bearing (rad)'],
    ['surfaceHeight', 0.002, 0.2, 0.002, 'sheet clearance (m)']
  ],
  'The fan': [
    ['fanConcentration', 0, 1, 0.005, 'in-plane momentum kept'],
    ['fanReach', 0.2, 12, 0.05, 'mean reach (m)'],
    ['fanPower', 0, 2, 0.01, 'outline follows density'],
    ['fanCrown', 0, 1, 0.005, 'crown lift × reach'],
    ['fanCrownFall', 0.2, 6, 0.05, 'crown fall-off'],
    ['fanThin', 0.05, 8, 0.05, 'thinning distance (m)'],
    ['fanBody', 0, 2, 0.01, 'body'],
    ['fanRimWidth', 0.01, 1, 0.005, 'rim width'],
    ['fanRimGain', 0, 2, 0.01, 'rim brightness'],
    ['fanOpacity', 0, 1, 0.005, 'opacity'],
    ['fanGlow', 0, 5, 0.01, 'glow'],
    ['fanSoftFade', 0.02, 2, 0.01, 'depth fade (m)']
  ],
  'The fan/Break-up': [
    ['fanFingers', 1, 48, 1, 'ligaments'],
    ['fanFingerDepth', 0, 1, 0.005, 'ligament depth'],
    ['fanFingerScale', 0.2, 10, 0.05, 'ligament scale'],
    ['fanFingerSpeed', 0, 20, 0.05, 'ligament crawl (Hz)'],
    ['fanRipple', 0, 0.6, 0.005, 'surface chop (m)'],
    ['fanRippleScale', 0.1, 10, 0.05, 'chop scale'],
    ['fanRippleSpeed', 0, 12, 0.05, 'chop speed (Hz)']
  ],
  'The fan/Shading': [
    ['fanFresnel', 0.5, 8, 0.05, 'grazing whitening'],
    ['fanSpecular', 0, 4, 0.01, 'specular'],
    ['fanGloss', 2, 160, 1, 'gloss'],
    ['colorSheet', 'sheet, thick'],
    ['colorSheetThin', 'sheet, stretched'],
    ['colorSheetRim', 'collected rim'],
    ['colorSheetSpray', 'crest / specular']
  ],
  'Spray, drops & mist': [
    ['sprayRate', 0, 1200, 5, 'spray rate'],
    ['spraySize', 0.005, 0.4, 0.005, 'spray size'],
    ['spraySpeed', 0, 40, 0.1, 'spray speed'],
    ['spraySpeedVariance', 0, 1, 0.01, 'spray speed scatter'],
    ['sprayLifetime', 0.1, 4, 0.05, 'spray lifetime'],
    ['sprayGravity', -50, 0, 0.1, 'spray gravity'],
    ['sprayStretch', 0, 8, 0.05, 'spray stretch'],
    ['sprayLift', 0, 1, 0.005, 'normal momentum kept'],
    ['sprayJitter', 0, 1.5, 0.005, 'bearing scatter (rad)'],
    ['dropRate', 0, 400, 1, 'drop rate'],
    ['dropSize', 0.005, 0.5, 0.005, 'drop size'],
    ['dropSpeed', 0, 25, 0.1, 'drop speed'],
    ['dropLifetime', 0.1, 5, 0.05, 'drop lifetime'],
    ['dropGravity', -50, 0, 0.1, 'drop gravity'],
    ['mistRate', 0, 600, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 12, 0.05, 'mist speed'],
    ['mistLifetime', 0.1, 6, 0.05, 'mist lifetime'],
    ['mistRise', -2, 6, 0.01, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['colorSpray*', 'Spray colour'],
    ['colorDrop*', 'Drop colour'],
    ['colorMist*', 'Mist colour']
  ],
  'The wet stone': [
    ['wetRadius', 0.2, 4, 0.01, 'patch × reach'],
    ['wetBias', 0, 2, 0.01, 'pushed downstream × reach'],
    ['wetGrow', 0.02, 2, 0.01, 'spread (s)'],
    ['wetDry', 0, 1, 0.005, 'drying on the fade'],
    ['wetHeight', 0.002, 0.2, 0.002, 'height above floor (m)'],
    ['wetEdge', 0.02, 2, 0.01, 'rim feather (m)'],
    ['wetRagged', 0, 1, 0.005, 'rim wander'],
    ['wetRaggedScale', 0.1, 4, 0.05, 'rim lobes / m'],
    ['wetWarp', 0, 3, 0.01, 'rim warp (m)'],
    ['wetDepth', 0.005, 0.6, 0.005, 'soak depth (m)'],
    ['wetLift', 0, 0.3, 0.002, 'ripple (m)'],
    ['wetCell', 0.05, 3, 0.01, 'puddles / m'],
    ['wetFlow', 0, 3, 0.01, 'ripple drift (m/s)'],
    ['wetSpeed', 0, 4, 0.01, 'ripple crawl (Hz)'],
    ['wetDetail', 0, 1, 0.005, 'detail'],
    ['wetRelief', 0, 2, 0.01, 'relief'],
    ['wetNormalStep', 0.01, 0.4, 0.005, 'normal tap (m)'],
    ['wetAmbient', 0, 1, 0.005, 'ambient'],
    ['wetWrap', 0, 1, 0.005, 'terminator wrap'],
    ['wetSpecular', 0, 3, 0.01, 'specular'],
    ['wetGloss', 2, 160, 1, 'gloss'],
    ['wetOpacity', 0, 1, 0.005, 'opacity'],
    ['wetEmissive', 0, 3, 0.01, 'emissive'],
    ['colorWetBase', 'damp stone'],
    ['colorWetEdge', 'sheen'],
    ['colorWetGlow', 'tide mark'],
    ['colorWetDeep', 'soak']
  ],
  'Marks on the floor': [
    ['foamRate', 0.05, 12, 0.05, 'foam marks / metre'],
    ['foamRadius', 0.05, 3, 0.01, 'foam radius (m)'],
    ['foamLife', 0.1, 8, 0.05, 'foam lifetime (s)'],
    ['foamIntensity', 0, 2, 0.01, 'foam intensity'],
    ['colorFoamA', 'foam body'],
    ['colorFoamB', 'foam edge']
  ],
  'The impact': [
    ['burstSize', 0.1, 8, 0.05, 'water burst (m)'],
    ['burstIntensity', 0, 3, 0.01, 'burst intensity'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake decay (s)'],
    ['rumble', 0, 0.6, 0.005, 'rumble while running'],
    ['impactFlash', 0, 2, 0.005, 'screen flash'],
    ['colorBurstA', 'burst body'],
    ['colorBurstB', 'burst rim'],
    ['colorBurstC', 'burst core'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'standing intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ],
  ...tubeSchema('jet', TubePath.STRAIGHT)
};
